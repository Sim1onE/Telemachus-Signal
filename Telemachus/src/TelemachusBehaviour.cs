//Author: Richard Bunt
using KSP.IO;
using System;
using System.Collections.Generic;
using System.Net;
using System.Reflection;
using System.Linq;
using System.Text;
using System.Timers;
using UnityEngine;
using WebSocketSharp.Server;
using System.Security.Cryptography.X509Certificates;
using WebSocketSharp; // Needed for WriteContent

namespace Telemachus
{
    class TelemachusBehaviour : MonoBehaviour
    {
        #region Fields

        public static GameObject instance;
        private DelayedAPIRunner delayedAPIRunner = new();
        private MainThreadDispatcher mainThreadDispatcher;

        #endregion

        #region Data Link

        private static HttpServer webServer = null;
        private static KSPWebServerDispatcher webDispatcher = null;
        private static KSPAPIBase apiInstance = null;

        private static PluginConfiguration config = PluginConfiguration.CreateForType<TelemachusBehaviour>();
        private static ServerConfiguration serverConfig = new();
        private static VesselChangeDetector vesselChangeDetector = null;

        // Create a default plugin manager to handle registrations
        private static PluginManager pluginManager = new();

        // Keep a list of handlers of the data uplink/downlink rate
        private static UpLinkDownLinkRate rateTracker = new();

        private static bool isPartless = false;
        public static bool IsShareMode = false;

        static public string getServerPrimaryIPAddress()
        {
            return serverConfig.ValidIpAddresses.First().ToString();
        }

        public static ServerConfiguration GetServerConfig() => serverConfig;
        public static bool IsServerRunning() => webServer != null && webServer.IsListening;

        static public void SaveConfig()
        {
            config.SetValue("PORT", serverConfig.port);
            config.SetValue("IPADDRESS", serverConfig.ipAddress.ToString());
            config.SetValue("USE_SSL", serverConfig.UseSsl ? 1 : 0);
            config.SetValue("HAS_PROMPTED_SSL", serverConfig.HasPromptedSsl ? 1 : 0);
            config.save();
        }

        static public void StartServer() => startDataLink();

        static public void SetSslPreference(bool useSsl)
        {
            serverConfig.UseSsl = useSsl;
            serverConfig.HasPromptedSsl = true;
            SaveConfig();

            if (IsServerRunning())
            {
                StopServer();
                StartServer();
            }
        }

        static public string getServerPort()
        {
            return serverConfig.port.ToString();
        }

        static private void startDataLink()
        {
            if (webServer == null)
            {
                try
                {
                    PluginLogger.print("Telemachus data link starting");

                    readConfiguration();

                    // Data access tools
                    vesselChangeDetector = new VesselChangeDetector(isPartless);
                    apiInstance = new KSPAPI(JSONFormatterProvider.Instance, vesselChangeDetector, serverConfig, pluginManager);

                    // Create the dispatcher and handlers. Handlers added in reverse priority order so that new ones are not ignored.
                    webDispatcher = new KSPWebServerDispatcher();

                    webDispatcher.AddResponder(new ElseResponsibility());
                    webDispatcher.AddResponder(new IOPageResponsibility());
                    var cameraLink = new CameraResponsibility(apiInstance, rateTracker);
                    webDispatcher.AddResponder(cameraLink);
                    var dataLink = new DataLinkResponsibility(apiInstance, rateTracker);
                    webDispatcher.AddResponder(dataLink);
                    var apiRoute = new APIRouteResponsibility(apiInstance, rateTracker);
                    webDispatcher.AddResponder(apiRoute);

                    // Add ShareModeResponsibility last so it evaluates first and overrides IOPageResponsibility
                    webDispatcher.AddResponder(new ShareModeResponsibility());

                    // --- SSL CONFIGURATION PRE-CHECK ---
                    X509Certificate2 cert = null;
                    if (serverConfig.UseSsl)
                    {
                        cert = TelemachusCertificateManager.GetServerCertificate(serverConfig, false);
                        if (cert == null)
                        {
                            PluginLogger.print("[SSL] Failed to load certificate. Falling back to HTTP.");
                            serverConfig.UseSsl = false;
                        }
                    }

                    // Create the server and associate the dispatcher
                    bool useSslNow = serverConfig.UseSsl && !IsShareMode;
                    if (serverConfig.ipAddress == System.Net.IPAddress.Any)
                    {
                        webServer = useSslNow ? new HttpServer(serverConfig.port, true) : new HttpServer(serverConfig.port);
                    }
                    else
                    {
                        webServer = useSslNow ? new HttpServer(serverConfig.ipAddress, serverConfig.port, true) : new HttpServer(serverConfig.ipAddress, serverConfig.port);
                    }

                    if (useSslNow && cert != null)
                    {
                        webServer.SslConfiguration.ServerCertificate = cert;
                        webServer.SslConfiguration.EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls12;
                        PluginLogger.print("[SSL] HTTPS Enabled with certificate: " + cert.Subject);
                    }

                    webServer.OnGet += (sender, e) =>
                    {
                        var request = e.Request;
                        var response = e.Response;

                        PluginLogger.print(string.Format("[Server] {0} {1} (Host: {2})", request.HttpMethod, request.RawUrl, request.UserHostName));

                        // CORS Headers
                        response.AddHeader("Access-Control-Allow-Origin", "*");
                        response.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                        response.AddHeader("Access-Control-Allow-Headers", "Content-Type, X-KSP-UT, X-KSP-Delay");

                        if (request.HttpMethod == "OPTIONS")
                        {
                            response.StatusCode = 200;
                            response.Close();
                            return;
                        }

                        // Handle root certificate download separately
                        if (request.RawUrl != null && request.RawUrl.Contains("/telemachus_root.cer"))
                        {
                            string certPath = TelemachusCertificateManager.GetRootCertPath();
                            if (System.IO.File.Exists(certPath))
                            {
                                response.ContentType = "application/x-x509-ca-cert";
                                response.AddHeader("Content-Disposition", "attachment; filename=\"telemachus_root.cer\"");
                                byte[] certBytes = System.IO.File.ReadAllBytes(certPath);
                                response.WriteContent(certBytes);
                            }
                            else
                            {
                                response.StatusCode = 404;
                                response.Close();
                            }
                            return;
                        }

                        webDispatcher.DispatchRequest(sender, e);
                    };

                    webServer.OnPost += (sender, e) =>
                    {
                        e.Response.AddHeader("Access-Control-Allow-Origin", "*");
                        webDispatcher.DispatchRequest(sender, e);
                    };

                    // Create the websocket server and attach to the web server
                    webServer.AddWebSocketService("/datalink", () => new KSPWebSocketService(apiInstance, rateTracker));
                    webServer.AddWebSocketService("/stream", () => new KSPUnifiedStreamService(rateTracker));

                    // Finally, start serving requests!
                    try
                    {
                        webServer.Start();
                    }
                    catch (Exception ex)
                    {
                        PluginLogger.print("Error starting web server: " + ex.ToString());
                        throw;
                    }

                    PluginLogger.print("Telemachus data link listening for requests on the following addresses: ("
                        + string.Join(", ", serverConfig.ValidIpAddresses.Select(x => x.ToString() + ":" + serverConfig.port.ToString()).ToArray())
                        + "). Try putting them into your web browser, some of them might not work.");
                }
                catch (Exception e)
                {
                    PluginLogger.print(e.Message);
                    PluginLogger.print(e.StackTrace);
                }
            }
        }

        static private void writeDefaultConfig()
        {
            config.SetValue("PORT", 8085);
            config.SetValue("IPADDRESS", "0.0.0.0");
            config.save();
        }

        static private void readConfiguration()
        {
            config.load();
            serverConfig.ValidIpAddresses.Clear();
            serverConfig.ValidIpAddresses.Add(IPAddress.Loopback);

            // Read the port out of the config file
            int port = config.GetValue<int>("PORT");
            if (port != 0 && port.IsPortNumber())
            {
                serverConfig.port = port;
            }
            else if (!port.IsPortNumber())
            {
                PluginLogger.print("Port specified in configuration file '" + serverConfig.port + "' must be a value between 1 and 65535 inclusive");
            }
            else
            {
                PluginLogger.print("No port in configuration file - using default of " + serverConfig.port.ToString());
            }

            // Read a specific IP address to bind to
            string ip = config.GetValue<String>("IPADDRESS");
            if (ip != null)
            {
                if (IPAddress.TryParse(ip, out IPAddress ipAddress))
                {
                    serverConfig.ipAddress = ipAddress;
                }
                else
                {
                    PluginLogger.print("Invalid IP address in configuration file, falling back to default");
                }
            }
            else
            {
                PluginLogger.print("No IP address in configuration file.");
            }

            // Enumerate other interfaces if bound to Any
            if (serverConfig.ipAddress.Equals(IPAddress.Any))
            {
                try
                {
                    foreach (var iface in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
                    {
                        if (iface.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up)
                            continue;
                        foreach (var addr in iface.GetIPProperties().UnicastAddresses)
                        {
                            if (addr.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork
                                && !IPAddress.IsLoopback(addr.Address))
                            {
                                PluginLogger.print("Found LAN address: " + addr.Address + " on " + iface.Name);
                                if (!serverConfig.ValidIpAddresses.Contains(addr.Address))
                                    serverConfig.ValidIpAddresses.Add(addr.Address);
                            }
                        }
                    }
                }
                catch (Exception e)
                {
                    PluginLogger.print("Could not enumerate network interfaces: " + e.Message
                        + "; server will listen on loopback only");
                }
            }
            else
            {
                if (!serverConfig.ValidIpAddresses.Contains(serverConfig.ipAddress))
                    serverConfig.ValidIpAddresses.Add(serverConfig.ipAddress);
            }

            serverConfig.version = Assembly.GetExecutingAssembly().GetName().Version.ToString();
            serverConfig.name = "Telemachus";

            serverConfig.UseSsl = config.GetValue<int>("USE_SSL") != 0;
            serverConfig.HasPromptedSsl = config.GetValue<int>("HAS_PROMPTED_SSL") != 0;
            isPartless = config.GetValue<int>("PARTLESS") != 0;

            PluginLogger.print("Partless:" + isPartless + " | SSL:" + serverConfig.UseSsl);
        }

        static public void StopServer() => stopDataLink();

        static private void stopDataLink()
        {
            if (webServer != null)
            {
                PluginLogger.print("Telemachus data link shutting down.");
                webServer.Stop();
                webServer = null;
            }
        }

        #endregion

        #region Behaviour Events

        public void Awake()
        {
            // Ensure the static instance is set even in partless mode
            // (TelemachusPowerDrain.OnAwake sets it when a part exists)
            instance ??= gameObject;

            LookForModsToInject();
            DontDestroyOnLoad(this);
            mainThreadDispatcher = gameObject.AddComponent<MainThreadDispatcher>();
            startDataLink();
        }

        public void OnDestroy()
        {
            stopDataLink();
        }

        public void Update()
        {
            delayedAPIRunner.execute();

            if (FlightGlobals.fetch != null && webServer != null)
            {
                vesselChangeDetector.update(FlightGlobals.ActiveVessel);

                foreach (var client in webServer.WebSocketServices["/datalink"].Sessions.Sessions.OfType<KSPWebSocketService>())
                {
                    if (client.UpdateRequired(Time.time))
                    {
                        client.SendDataUpdate();
                    }
                }

                foreach (var client in webServer.WebSocketServices["/stream"].Sessions.Sessions.OfType<KSPUnifiedStreamService>())
                {
                    client.ProcessUpdate();
                }
            }
            else
            {
                PluginLogger.debug("Flight globals was null during start up; skipping update of vessel change.");
            }
        }


        void LookForModsToInject()
        {
            string foundMods = "Loading; Looking for compatible mods to inject registration....\nTelemachus compatible modules Found:\n";
            int found = 0;
            foreach (var asm in AssemblyLoader.loadedAssemblies)
            {
                foreach (var type in asm.assembly.GetTypes())
                {
                    if (type.IsSubclassOf(typeof(MonoBehaviour)))
                    {
                        // Does this have a static property named "Func<string> TelemachusPluginRegister { get; set; }?
                        var prop = type.GetProperty("TelemachusPluginRegister", BindingFlags.Static | BindingFlags.Public);
                        if (prop == null) continue;
                        found += 1;
                        foundMods += "  - " + type.ToString() + " ";
                        if (prop.PropertyType != typeof(Action<object>))
                        {
                            foundMods += "(Fail - Invalid property type)\n";
                            continue;
                        }

                        if (!prop.CanWrite)
                        {
                            foundMods += "(Fail - Property not writeable)\n";
                            continue;
                        }
                        // Can we read it - if so, only write if it is not null.
                        if (prop.CanRead)
                        {
                            if (prop.GetValue(null, null) != null)
                            {
                                foundMods += "(Fail - Property not null)\n";
                                continue;
                            }
                        }
                        // Write the value here
                        Action<object> pluginRegister = PluginRegistration.Register;
                        prop.SetValue(null, pluginRegister, null);
                        foundMods += "(Success)\n";
                    }
                }
            }
            if (found == 0) foundMods += "  None\n";

            foundMods += "Internal plugins loaded:\n";
            found = 0;
            // Look for any mods in THIS assembly that inherit ITelemachusMinimalPlugin...
            foreach (var typ in Assembly.GetExecutingAssembly().GetTypes())
            {
                try
                {
                    if (!typeof(IMinimalTelemachusPlugin).IsAssignableFrom(typ)) continue;
                    // Make sure we have a default constructor
                    if (typ.GetConstructor(Type.EmptyTypes) == null) continue;
                    // We have found a plugin internally. Instantiate it
                    PluginRegistration.Register(Activator.CreateInstance(typ));

                    foundMods += "  - " + typ.ToString() + "\n";
                    found += 1;
                }
                catch (Exception ex)
                {
                    PluginLogger.print("Exception caught whilst loading internal plugin " + typ.ToString() + "; " + ex.ToString());
                }
            }
            if (found == 0) foundMods += "  None";
            PluginLogger.print(foundMods);
        }
        #endregion

        #region DataRate

        static public double getDownLinkRate()
        {
            return rateTracker.getDownLinkRate();
        }

        static public double getUpLinkRate()
        {
            return rateTracker.getUpLinkRate();
        }

        #endregion

        #region Delayed API Runner

        public void queueDelayedAPI(DelayedAPIEntry entry)
        {
            delayedAPIRunner.queue(entry);
        }

        #endregion
    }

    public class DelayedAPIRunner
    {
        #region Fields

        List<DelayedAPIEntry> actionQueue = new();

        #endregion

        #region Lock

        readonly private object queueLock = new();

        #endregion

        #region Methods

        public void execute()
        {
            lock (queueLock)
            {
                foreach (DelayedAPIEntry entry in actionQueue)
                {
                    entry.call();
                }

                actionQueue.Clear();
            }
        }

        public void queue(DelayedAPIEntry delayedAPIEntry)
        {
            lock (queueLock)
            {
                actionQueue.Add(delayedAPIEntry);
            }
        }

        #endregion
    }
}
