//Author: Richard Bunt
using System;
using System.Collections.Generic;
using System.Text;
using System.Linq;
using System.Reflection;
using WebSocketSharp.Net;
using WebSocketSharp; // NECESSARIO per i metodi di estensione come WriteContent
using UnityEngine;
using Telemachus.CameraSnapshots;
using System.Text.RegularExpressions;
using System.Globalization;

namespace Telemachus
{
    public class CameraResponsibility : IHTTPRequestResponder
    {
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

        private KSPAPIBase kspAPI = null;
        private UpLinkDownLinkRate dataRates = null;

        public CameraResponsibility(KSPAPIBase kspAPI, UpLinkDownLinkRate rateTracker)
        {
            this.kspAPI = kspAPI;
            dataRates = rateTracker;
        }

        public string cameraURL(HttpListenerRequest request, CameraCapture camera)
        {
            // Controllo robusto per l'header dell'host
            String hostname = request.Headers[NGROK_ORIGINAL_HOST_HEADER] != null 
                ? request.Headers[NGROK_ORIGINAL_HOST_HEADER] 
                : request.UserHostName;

            return request.Url.Scheme + "://" + hostname + PAGE_PREFIX + "/" + Uri.EscapeDataString(camera.cameraManagerName());
        }

        public bool processCameraManagerIndex(HttpListenerRequest request, HttpListenerResponse response)
        {
            if (CameraCaptureManager.classedInstance != null) {
                CameraCaptureManager.classedInstance.EnsureFlightCamera();
            }

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
            response.WriteContent(jsonBytes); // Ora rifunziona grazie a 'using WebSocketSharp'
            dataRates.SendDataToClient(jsonBytes.Length);

            return true;
        }

        public bool processCameraImageRequest(string cameraName, HttpListenerRequest request, HttpListenerResponse response)
        {
            cameraName = cameraName.ToLower();

            if (!CameraCaptureManager.classedInstance.cameras.ContainsKey(cameraName))
            {
                response.StatusCode = 404;
                return true;
            }

            CameraCapture camera = CameraCaptureManager.classedInstance.cameras[cameraName];

            // Keep renderer active
            camera.lastRequestTick = Environment.TickCount;

            // Single Frame Polling (Legacy Support)
            if (camera.didRender && camera.imageBytes != null)
            {
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
                response.StatusCode = 503;
            }

            return true;
        }

        public bool process(HttpListenerRequest request, HttpListenerResponse response)
        {
            if (request.Url.AbsolutePath.TrimEnd('/').ToLower() == CAMERA_LIST_ENDPOINT)
            {
                dataRates.RecieveDataFromClient(request.RawUrl.Length + (int)request.ContentLength64);
                return processCameraManagerIndex(request, response);
            }
            else if (cameraNameEndpointRegex.IsMatch(request.Url.AbsolutePath))
            {
                Match match = cameraNameEndpointRegex.Match(request.Url.AbsolutePath);
                string cameraName = Uri.UnescapeDataString(match.Groups[1].Value);
                return processCameraImageRequest(cameraName, request, response);
            }

            return false;
        }
    }
}
