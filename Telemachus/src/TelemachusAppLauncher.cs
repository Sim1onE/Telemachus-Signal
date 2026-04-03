using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using KSP.UI.Screens;
using UnityEngine;

namespace Telemachus
{
    [KSPAddon(KSPAddon.Startup.AllGameScenes, false)]
    public class TelemachusAppLauncher : MonoBehaviour
    {
        private static ApplicationLauncherButton _button = null;
        private static bool _showMenu = false;
        private Rect _windowRect = new Rect(300, 300, 300, 350);
        private int _windowID = 99124;

        private static bool _showSslPrompt = false;

        void Awake()
        {
            GameEvents.onGUIApplicationLauncherReady.Add(OnAppLauncherReady);
            GameEvents.onGUIApplicationLauncherDestroyed.Add(OnAppLauncherDestroyed);
        }

        void OnDestroy()
        {
            GameEvents.onGUIApplicationLauncherReady.Remove(OnAppLauncherReady);
            GameEvents.onGUIApplicationLauncherDestroyed.Remove(OnAppLauncherDestroyed);
            if (_button != null)
            {
                ApplicationLauncher.Instance.RemoveModApplication(_button);
                _button = null;
            }
        }

        void OnAppLauncherReady()
        {
            if (_button == null)
            {
                // We use your logo.png for the toolbar
                Texture2D icon = GameDatabase.Instance.GetTexture("Telemachus/Textures/logo", false);
                if (icon == null) icon = Texture2D.whiteTexture;

                _button = ApplicationLauncher.Instance.AddModApplication(
                    OnShow, OnHide, null, null, null, null,
                    ApplicationLauncher.AppScenes.ALWAYS, icon);
            }
        }

        void OnAppLauncherDestroyed()
        {
            if (_button != null)
            {
                ApplicationLauncher.Instance.RemoveModApplication(_button);
                _button = null;
            }
        }

        void OnShow() 
        { 
            _showMenu = true; 
            TelemachusCertificateManager.ForceRefreshTrustCheck();
        }
        void OnHide() => _showMenu = false;

        public static void SetPromptSsl(bool show) => _showSslPrompt = show;

        void OnGUI()
        {
            if (_showSslPrompt)
            {
                DrawSslStartupPrompt();
            }

            if (_showMenu)
            {
                _windowRect = GUILayout.Window(_windowID, _windowRect, DrawSettingsWindow, "TELEMACHUS CONTROL", GUILayout.Width(300));
            }
        }

        private void DrawSslStartupPrompt()
        {
            Rect promptRect = new Rect(Screen.width / 2 - 200, Screen.height / 2 - 150, 400, 300);
            GUI.Box(promptRect, "Telemachus - Security Settings");
            GUILayout.BeginArea(promptRect);
            GUILayout.Space(20);
            GUILayout.Label("<color=yellow><b>ENABLE HTTPS ENCRYPTION?</b></color>", new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontSize = 16, richText = true });
            GUILayout.Space(10);
            GUILayout.Label("Modern browsers block audio and advanced features on non-secure connections.\n\n" +
                            "To enable HTTPS, Telemachus must install a local security certificate.\n\n" +
                            "<b>What happens:</b>\n" +
                            "1. A window from your operating system (UAC/CertMgr) will ask for confirmation.\n" +
                            "2. After accepting, you will have a 'Green Lock' and working audio in your browser.",
                            new GUIStyle(GUI.skin.label) { wordWrap = true, padding = new RectOffset(10, 10, 0, 0), richText = true });

            GUILayout.FlexibleSpace();
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("YES (Enable HTTPS)", GUILayout.Height(40)))
            {
                // Force fresh generation
                var config = TelemachusBehaviour.GetServerConfig();
                TelemachusCertificateManager.GetServerCertificate(config, true);
                TelemachusBehaviour.SetSslPreference(true);
                TelemachusCertificateManager.TrustRootCertificate();
                TelemachusCertificateManager.ForceRefreshTrustCheck();
                _showSslPrompt = false;
            }
            if (GUILayout.Button("NO (Stay on HTTP)", GUILayout.Height(40)))
            {
                TelemachusBehaviour.SetSslPreference(false);
                _showSslPrompt = false;
            }
            GUILayout.EndHorizontal();
            GUILayout.Space(10);
            GUILayout.EndArea();
        }

        private void DrawSettingsWindow(int id)
        {
            var config = TelemachusBehaviour.GetServerConfig();

            GUILayout.BeginVertical();

            if (TelemachusBehaviour.IsShareMode)
            {
                GUILayout.Label("<color=#4cc9f0><b>SHARE MODE ACTIVE</b></color>", new GUIStyle(GUI.skin.label) { richText = true, fontSize = 16, alignment = TextAnchor.MiddleCenter });
                GUILayout.Space(10);
                GUILayout.Label("The server is temporarily running in unencrypted mode (HTTP).", new GUIStyle(GUI.skin.label) { wordWrap = true });
                GUILayout.Space(10);
                GUILayout.Label("<b>1.</b> Send one of the links below to your remote browser.", new GUIStyle(GUI.skin.label) { richText = true });
                GUILayout.Label("<b>2.</b> Tell them to download and install the Certificate.", new GUIStyle(GUI.skin.label) { richText = true });
                GUILayout.Label("<b>3.</b> Close this mode to resume high-security transmission.", new GUIStyle(GUI.skin.label) { richText = true });
                
                GUILayout.Space(15);
                foreach (var ip in config.ValidIpAddresses)
                {
                    string displayIp = ip.Equals(System.Net.IPAddress.Loopback) ? "localhost" : ip.ToString();
                    string url = $"http://{displayIp}:{config.port}/";
                    GUILayout.BeginHorizontal();
                    GUILayout.Label(url, GUILayout.ExpandWidth(true));
                    if (GUILayout.Button("COPY", GUILayout.Width(60)))
                    {
                        GUIUtility.systemCopyBuffer = url;
                        ScreenMessages.PostScreenMessage("Install Link copied!", 3.0f, ScreenMessageStyle.UPPER_CENTER);
                    }
                    GUILayout.EndHorizontal();
                }

                GUILayout.Space(20);
                if (GUILayout.Button("<color=#ff4c4c><b>EXIT SHARE MODE</b></color>", new GUIStyle(GUI.skin.button) { richText = true, fixedHeight = 40 }))
                {
                    TelemachusBehaviour.IsShareMode = false;
                    if (TelemachusBehaviour.IsServerRunning()) {
                        TelemachusBehaviour.StopServer();
                        TelemachusBehaviour.StartServer();
                    }
                }
            }
            else
            {
                GUILayout.Label("<b>SERVER STATUS</b>", new GUIStyle(GUI.skin.label) { richText = true });
                bool isRunning = TelemachusBehaviour.IsServerRunning();
                GUILayout.Label(isRunning ? "<color=green>ONLINE</color>" : "<color=red>OFFLINE</color>", new GUIStyle(GUI.skin.label) { richText = true, fontSize = 14 });

                if (GUILayout.Button(isRunning ? "STOP SERVER" : "START SERVER", GUILayout.Height(30)))
                {
                    if (isRunning) TelemachusBehaviour.StopServer();
                    else TelemachusBehaviour.StartServer();
                }

                GUILayout.Space(15);
                GUILayout.Label("<b>NETWORK CONFIG</b>", new GUIStyle(GUI.skin.label) { richText = true });

                GUILayout.BeginHorizontal();
                GUILayout.Label("Port:", GUILayout.Width(50));
                string newPortStr = GUILayout.TextField(config.port.ToString(), 5);
                if (int.TryParse(newPortStr, out int p)) config.port = p;
                GUILayout.EndHorizontal();

                GUILayout.Space(10);
                bool useSsl = GUILayout.Toggle(config.UseSsl, "Enable SSL (HTTPS/WSS) required for Audio");
                if (useSsl != config.UseSsl)
                {
                    config.UseSsl = useSsl;
                    TelemachusBehaviour.SaveConfig();
                }

                if (config.UseSsl)
                {
                    bool isTrusted = TelemachusCertificateManager.IsRootTrusted();
                    GUILayout.Label(isTrusted ? "<color=white>Certificate Status: <color=green>Trusted</color></color>" : "<color=white>Certificate Status: <color=yellow>Not Trusted</color></color>", new GUIStyle(GUI.skin.label) { richText = true });

                    if (GUILayout.Button("REFRESH / TRUST CERTIFICATE"))
                    {
                        TelemachusCertificateManager.GetServerCertificate(config, true);
                        TelemachusCertificateManager.TrustRootCertificate();
                        TelemachusCertificateManager.ForceRefreshTrustCheck();

                        if (TelemachusBehaviour.IsServerRunning()) {
                            TelemachusBehaviour.StopServer();
                            TelemachusBehaviour.StartServer();
                        }
                    }
                    
                    GUILayout.Space(5);
                    if (GUILayout.Button("<color=#4cc9f0><b>ENTER SHARE MODE (INVITE DEVICE)</b></color>", new GUIStyle(GUI.skin.button) { richText = true, fixedHeight = 35 }))
                    {
                        TelemachusBehaviour.IsShareMode = true;
                        if (TelemachusBehaviour.IsServerRunning()) {
                            TelemachusBehaviour.StopServer();
                            TelemachusBehaviour.StartServer();
                        }
                    }
                }
            }

            if (!TelemachusBehaviour.IsShareMode)
            {
                GUILayout.Space(15);
                GUILayout.Label("<b>ACCESS URLS (Click to Copy)</b>", new GUIStyle(GUI.skin.label) { richText = true });
                string scheme = config.UseSsl ? "https" : "http";
                foreach (var ip in config.ValidIpAddresses)
                {
                    string displayIp = ip.Equals(System.Net.IPAddress.Loopback) ? "localhost" : ip.ToString();
                    string fullUrl = $"{scheme}://{displayIp}:{config.port}/";
                    
                    GUILayout.BeginHorizontal();
                    GUILayout.Label(fullUrl, GUILayout.ExpandWidth(true));
                    if (GUILayout.Button("COPY", GUILayout.Width(60)))
                    {
                        GUIUtility.systemCopyBuffer = fullUrl;
                        ScreenMessages.PostScreenMessage("Indirizzo copiato!", 3.0f, ScreenMessageStyle.UPPER_CENTER);
                    }
                    GUILayout.EndHorizontal();
                }
            }

            GUILayout.FlexibleSpace();
            if (GUILayout.Button("HIDE MENU")) _button.SetFalse();

            GUILayout.EndVertical();
            GUI.DragWindow();
        }
    }
}
