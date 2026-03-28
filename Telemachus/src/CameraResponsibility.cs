//Author: Richard Bunt
using System;
using System.Collections.Generic;
using System.Text;
using System.Linq;
using System.Threading;
using System.Reflection;
using WebSocketSharp.Net;
using WebSocketSharp;
using UnityEngine;
using System.Collections;
using Telemachus.CameraSnapshots;
using System.Text.RegularExpressions;
using System.Globalization;
using System.Collections.Specialized;

namespace Telemachus
{
    public class CameraResponsibility : IHTTPRequestResponder
    {
        /// The page prefix that this class handles
        public const String PAGE_PREFIX = "/telemachus/cameras";
        public const String CAMERA_LIST_ENDPOINT = PAGE_PREFIX;
        public const String NGROK_ORIGINAL_HOST_HEADER = "X-Original-Host";
        protected Regex _cameraNameEndpointRegex;
        protected Regex cameraNameEndpointRegex
        {
            get
            {
                _cameraNameEndpointRegex ??= new Regex(Regex.Escape(PAGE_PREFIX) + "\\/(.+)");
                return _cameraNameEndpointRegex;
            }
        }

        /// The KSP API to use to access variable data
        private KSPAPIBase kspAPI = null;

        private UpLinkDownLinkRate dataRates = null;



        #region Initialisation

        public CameraResponsibility(KSPAPIBase kspAPI, UpLinkDownLinkRate rateTracker)
        {
            this.kspAPI = kspAPI;
            dataRates = rateTracker;
        }

        #endregion

        public string cameraURL(HttpListenerRequest request, CameraCapture camera)
        {
            String hostname = "";
            if (request.Headers.Contains(NGROK_ORIGINAL_HOST_HEADER))
            {
                hostname = request.Headers[NGROK_ORIGINAL_HOST_HEADER];
            }
            else
            {
                hostname = request.UserHostName;
            }

            return request.Url.Scheme + "://" + hostname + PAGE_PREFIX + "/" + Uri.EscapeDataString(camera.cameraManagerName());
        }

        public bool processCameraManagerIndex(HttpListenerRequest request, HttpListenerResponse response)
        {
            CameraCaptureManager.classedInstance.EnsureFlightCamera();

            var jsonObject = new List<Dictionary<string, object>>();

            foreach (KeyValuePair<string, CameraCapture> cameraKVP in CameraCaptureManager.classedInstance.cameras)
            {
                var jsonData = new Dictionary<string, object>();
                jsonData["name"] = cameraKVP.Value.cameraManagerName();
                jsonData["type"] = cameraKVP.Value.cameraType();
                jsonData["url"] = cameraURL(request, cameraKVP.Value);
                jsonData["fovMin"] = cameraKVP.Value.minFOV;
                jsonData["fovMax"] = cameraKVP.Value.maxFOV;
                jsonData["currentFov"] = cameraKVP.Value.interpolatedFOV;

                jsonObject.Add(jsonData);
            }

            byte[] jsonBytes = Encoding.UTF8.GetBytes(Json.Encode(jsonObject));

            response.ContentEncoding = Encoding.UTF8;
            response.ContentType = "application/json";
            response.WriteContent(jsonBytes);
            dataRates.SendDataToClient(jsonBytes.Length);

            return true;
        }

        public bool processCameraImageRequest(string cameraName, HttpListenerRequest request, HttpListenerResponse response)
        {
            cameraName = cameraName.ToLower();
            bool isStream = false;

            if (cameraName.StartsWith("stream/"))
            {
                isStream = true;
                cameraName = cameraName.Substring(7); // remove "stream/"
            }

            if (!CameraCaptureManager.classedInstance.cameras.ContainsKey(cameraName))
            {
                response.StatusCode = 404;
                return true;
            }

            CameraCapture camera = CameraCaptureManager.classedInstance.cameras[cameraName];

            // Handle RESTful command updates (POST)
            if (request.HttpMethod == "POST")
            {
                try {
                    using (var reader = new System.IO.StreamReader(request.InputStream))
                    {
                        string body = reader.ReadToEnd();
                        var json = Telemachus.Json.DecodeObject(body) as Dictionary<string, object>;
                        if (json != null && json.ContainsKey("fov"))
                        {
                            float fovVal = Convert.ToSingle(json["fov"]);
                            if (fovVal < 0) camera.customFOV = -1f;
                            else camera.customFOV = Mathf.Clamp(fovVal, camera.minFOV, camera.maxFOV);
                        }
                    }
                    response.StatusCode = 204; // No Content
                    return true;
                } catch (Exception ex) {
                    PluginLogger.print("Error processing POST: " + ex.Message);
                    response.StatusCode = 400;
                    return true;
                }
            }

            // --- Legacy GET parameter handling ---
            string fovQuery = request.QueryString["fov"];
            if (fovQuery == null && request.Url.Query.Contains("fov="))
            {
                // Fallback physical extraction just in case
                string q = request.Url.Query;
                int idx = q.IndexOf("fov=") + 4;
                int amp = q.IndexOf("&", idx);
                fovQuery = amp > -1 ? q.Substring(idx, amp - idx) : q.Substring(idx);
            }

            if (fovQuery != null && float.TryParse(fovQuery, NumberStyles.Any, CultureInfo.InvariantCulture, out float fovValLegacy))
            {
                if (fovValLegacy < 0) camera.customFOV = -1f;
                else camera.customFOV = Mathf.Clamp(fovValLegacy, camera.minFOV, camera.maxFOV);
            }

            // Update last request tick to keep renderer active
            camera.lastRequestTick = Environment.TickCount;

            if (isStream)
            {
                response.ContentType = "multipart/x-mixed-replace; boundary=--myboundary";
                response.SendChunked = true;

                try
                {
                    while (true)
                    {
                        if (camera.didRender && camera.imageBytes != null)
                        {
                            camera.lastRequestTick = Environment.TickCount;

                            byte[] img = camera.imageBytes; // Thread-safe copy reference

                            // Planetarium might throw if not in flight, but CameraCapture is only in flight
                            double currentUT = HighLogic.LoadedSceneIsFlight && Planetarium.fetch != null ? Planetarium.GetUniversalTime() : 0;
                            double currentDelay = (FlightGlobals.ActiveVessel != null && FlightGlobals.ActiveVessel.Connection != null) ? 
                                                    FlightGlobals.ActiveVessel.Connection.SignalDelay : 0;
                            double currentWarp = TimeWarp.CurrentRate;

                            string header = "--myboundary\r\n" +
                                            "Content-Type: image/jpeg\r\n" +
                                            "X-KSP-UT: " + currentUT.ToString("F3", CultureInfo.InvariantCulture) + "\r\n" +
                                            "X-KSP-Delay: " + currentDelay.ToString("F3", CultureInfo.InvariantCulture) + "\r\n" +
                                            "X-KSP-Warp: " + currentWarp.ToString("F1", CultureInfo.InvariantCulture) + "\r\n" +
                                            "X-KSP-FOV: " + camera.interpolatedFOV.ToString("F1", CultureInfo.InvariantCulture) + "\r\n" +
                                            "Content-Length: " + img.Length + "\r\n\r\n";

                            byte[] headerBytes = Encoding.UTF8.GetBytes(header);
                            response.OutputStream.Write(headerBytes, 0, headerBytes.Length);
                            response.OutputStream.Write(img, 0, img.Length);

                            byte[] footerBytes = Encoding.UTF8.GetBytes("\r\n");
                            response.OutputStream.Write(footerBytes, 0, footerBytes.Length);
                            response.OutputStream.Flush();

                            dataRates.SendDataToClient(headerBytes.Length + img.Length + footerBytes.Length);

                            // Reduce sleep to 10ms to support 30+ FPS comfortably
                            System.Threading.Thread.Sleep(10);
                        }
                        else
                        {
                            // If first frame not ready, update tick to trigger render and wait
                            camera.lastRequestTick = Environment.TickCount;
                            System.Threading.Thread.Sleep(100);
                        }
                    }
                }
                catch (Exception)
                {
                    // Client disconnected or stream closed
                }
            }
            else
            {
                if (camera.didRender && camera.imageBytes != null)
                {
                    response.ContentEncoding = Encoding.UTF8;
                    response.ContentType = "image/jpeg";
                    response.AddHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                    response.AddHeader("Pragma", "no-cache");
                    response.AddHeader("Expires", "0");

                    double currentUT = HighLogic.LoadedSceneIsFlight && Planetarium.fetch != null ? Planetarium.GetUniversalTime() : 0;
                    response.AddHeader("X-KSP-UT", currentUT.ToString("F3", CultureInfo.InvariantCulture));

                    response.WriteContent(camera.imageBytes);
                    dataRates.SendDataToClient(camera.imageBytes.Length);
                }
                else
                {
                    // Try to trigger a render even if not ready
                    camera.lastRequestTick = Environment.TickCount;
                    response.StatusCode = 503;
                }
            }

            return true;
        }

        public bool process(HttpListenerRequest request, HttpListenerResponse response)
        {
            //PluginLogger.debug(request.Url.AbsolutePath.TrimEnd('/'));
            //PluginLogger.debug(String.Join(",", CameraCaptureManager.classedInstance.cameras.Keys.ToArray()));
            //PluginLogger.debug("FLIGHT CAMERA: " + this.cameraCaptureTest);
            if (request.Url.AbsolutePath.TrimEnd('/').ToLower() == CAMERA_LIST_ENDPOINT)
            {
                // Work out how big this request was
                long byteCount = request.RawUrl.Length + request.ContentLength64;
                // Don't count headers + request.Headers.AllKeys.Sum(x => x.Length + request.Headers[x].Length + 1);
                dataRates.RecieveDataFromClient(Convert.ToInt32(byteCount));

                return processCameraManagerIndex(request, response);
            }
            else if (cameraNameEndpointRegex.IsMatch(request.Url.AbsolutePath))
            {
                Match match = cameraNameEndpointRegex.Match(request.Url.AbsolutePath);
                string cameraName = Uri.UnescapeDataString(match.Groups[1].Value);
                //PluginLogger.debug("GET CAMERA: " + cameraName);
                return processCameraImageRequest(cameraName, request, response);
            }

            return false;
        }
    }
}
