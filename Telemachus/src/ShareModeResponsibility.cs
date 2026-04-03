using System;
using System.IO;
using System.Text;
using WebSocketSharp.Net;
using WebSocketSharp.Server;
using WebSocketSharp; // Needed for WriteContent extension

namespace Telemachus
{
    public class ShareModeResponsibility : IHTTPRequestResponder
    {
        public bool process(HttpListenerRequest request, HttpListenerResponse response)
        {
            if (!TelemachusBehaviour.IsShareMode)
            {
                return false; // Non in Share Mode, non gestire questa richiesta
            }

            string url = request.RawUrl.ToLower();

            // Gestione download certificato e script di trust
            if (url == "/telemachus_root.cer")
            {
                return serveFile(TelemachusCertificateManager.GetRootCertPath(), "application/x-x509-ca-cert", response);
            }

            if (url == "/trust-win.bat")
            {
                string host = request.UserHostName ?? "localhost";
                string script = $@"@echo off
setlocal
set CERT_URL=http://{host}/telemachus_root.cer
set CERT_PATH=%TEMP%\telemachus_root.cer

echo --------------------------------------------------
echo Telemachus SSL Setup - Windows 1-Click Installer
echo --------------------------------------------------
echo Downloading certificate from: %CERT_URL%
powershell -Command ""(New-Object System.Net.WebClient).DownloadFile('%CERT_URL%', '%CERT_PATH%')""

echo Installing certificate into Trusted Root Store...
echo IMPORTANT: Click 'Yes' if Windows asks for permission.
powershell -Command ""Start-Process certutil.exe -ArgumentList '-user -addstore Root \""%CERT_PATH%\""' -Wait -Verb RunAs""

if %ERRORLEVEL% EQU 0 (
    echo.
    echo SUCCESS: Certificate installed correctly!
    echo You can now close this window and use the Secure Link on the web page.
) else (
    echo.
    echo ERROR: Installation failed or was cancelled.
)

del ""%CERT_PATH%""
pause";
                return serveString(script, "application/bat", response);
            }

            if (url == "/trust-unix.sh")
            {
                string host = request.UserHostName ?? "localhost";
                string script = $@"#!/bin/bash
CERT_URL=""http://{host}/telemachus_root.cer""
CERT_TEMP=""/tmp/telemachus_root.cer""

echo ""--------------------------------------------------""
echo ""Telemachus SSL Setup - Unix/macOS Installer""
echo ""--------------------------------------------------""
echo ""Downloading certificate...""
curl -s $CERT_URL -o $CERT_TEMP

if [[ ""$OSTYPE"" == ""darwin""* ]]; then
    echo ""Installing to macOS Keychain (requires password)...""
    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain $CERT_TEMP
else
    echo ""Installing to Linux CA store (requires sudo)...""
    sudo cp $CERT_TEMP /usr/local/share/ca-certificates/telemachus_root.crt
    sudo update-ca-certificates
fi

rm $CERT_TEMP
echo ""Done! You can now close this terminal.""";
                return serveString(script, "application/x-sh", response);
            }

            // In Share Mode intercettiamo tutto ciò che non è un'API o un asset specifico e forziamo cert-setup.html
            // Questo include la root "/", "/telemachus", e anche l'index normale se c'è un redirect.
            if (url == "/" || url == "/telemachus" || url == "/telemachus/" || url == "/telemachus/index.html")
            {
                string telemachusDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
                // Risaliamo alla cartella principale del mod (GameData/Telemachus)
                string rootFolder = Directory.GetParent(telemachusDir).FullName;
                string contentPath = Path.Combine(rootFolder, "Plugins", "PluginData", "Telemachus", "cert-setup.html");

                return serveFile(contentPath, "text/html; charset=UTF-8", response);
            }

            return false; // Non è una richiesta target, lascia gestire agli altri responder
        }

        private bool serveFile(string path, string contentType, HttpListenerResponse response)
        {
            if (File.Exists(path))
            {
                try
                {
                    byte[] bytes = File.ReadAllBytes(path);
                    response.ContentType = contentType;
                    response.WriteContent(bytes);
                    return true;
                }
                catch (Exception ex)
                {
                    PluginLogger.print("Error serving " + path + ": " + ex.ToString());
                    response.StatusCode = (int)HttpStatusCode.InternalServerError;
                    response.Close();
                    return true;
                }
            }
            else
            {
                PluginLogger.print("File not found at: " + path);
                response.StatusCode = (int)HttpStatusCode.NotFound;
                response.WriteContent(Encoding.UTF8.GetBytes("Error: File not found at " + path));
                return true;
            }
        }

        private bool serveString(string content, string contentType, HttpListenerResponse response)
        {
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(content);
                response.ContentType = contentType;
                response.WriteContent(bytes);
                return true;
            }
            catch (Exception ex)
            {
                PluginLogger.print("Error serving dynamic content: " + ex.ToString());
                response.StatusCode = (int)HttpStatusCode.InternalServerError;
                response.Close();
                return true;
            }
        }
    }
}
