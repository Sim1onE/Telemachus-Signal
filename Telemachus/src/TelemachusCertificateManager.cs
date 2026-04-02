using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Diagnostics;
using System.Linq;

namespace Telemachus
{
    public static class TelemachusCertificateManager
    {
        private const string ROOT_SUBJECT = "CN=Telemachus (Local Root CA)";

        public static X509Certificate2 GetServerCertificate(ServerConfiguration config, bool force = false)
        {
            try
            {
                string telemachusDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
                string certDir = Path.Combine(Directory.GetParent(telemachusDir).FullName, "Certificates");
                if (!Directory.Exists(certDir)) Directory.CreateDirectory(certDir);

                string pfxPath = Path.Combine(certDir, "telemachus_host.pfx");
                string rootCerPath = Path.Combine(certDir, "telemachus_root.cer");

                if (force)
                {
                    PluginLogger.print("[SSL] Forced regeneration. Deleting old files...");
                    if (File.Exists(pfxPath)) File.Delete(pfxPath);
                    if (File.Exists(rootCerPath)) File.Delete(rootCerPath);
                }

                if (File.Exists(pfxPath) && new FileInfo(pfxPath).Length > 0)
                {
                    var loadedCert = new X509Certificate2(pfxPath, config.CertificatePassword, X509KeyStorageFlags.Exportable | X509KeyStorageFlags.PersistKeySet);
                    PluginLogger.print($"[SSL] Certificate Loaded: {loadedCert.Subject} (HasPrivateKey={loadedCert.HasPrivateKey}, Thumbprint={loadedCert.Thumbprint})");
                    return loadedCert;
                }

                PluginLogger.print("[SSL] Generating new Standalone Certificates via PowerShell...");
                GenerateSelfSignedCerts(config, pfxPath, rootCerPath);

                var generatedCert = new X509Certificate2(pfxPath, config.CertificatePassword, X509KeyStorageFlags.Exportable | X509KeyStorageFlags.PersistKeySet);
                PluginLogger.print($"[SSL] New Certificate Generated: {generatedCert.Subject} (Thumbprint={generatedCert.Thumbprint})");
                return generatedCert;
            }
            catch (Exception ex)
            {
                PluginLogger.print("[SSL] CRITICAL Certificate Error: " + ex.Message + "\n" + ex.StackTrace);
                return null;
            }
        }

        private static bool _cachedTrust = false;
        private static bool _needsCheck = true;

        public static void ForceRefreshTrustCheck()
        {
            _needsCheck = true;
        }

        public static bool IsRootTrusted()
        {
            if (!_needsCheck) return _cachedTrust;

            _needsCheck = false;
            try
            {
                // PowerShell check is expensive, run ONLY when requested (menu open or generation)
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Subject -match 'Telemachus' } | Select-Object -ExpandProperty Subject\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true
                };

                using (var process = Process.Start(psi))
                {
                    string output = process.StandardOutput.ReadToEnd();
                    process.WaitForExit();
                    _cachedTrust = !string.IsNullOrEmpty(output) && output.Contains("Telemachus");
                    if (_cachedTrust) PluginLogger.print("[SSL] Root CA trust confirmed via PowerShell.");
                    return _cachedTrust;
                }
            }
            catch (Exception ex)
            {
                PluginLogger.print("[SSL] Error checking trust via PowerShell: " + ex.Message);
            }
            return false;
        }

        public static void TrustRootCertificate()
        {
            string telemachusDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string certPath = Path.Combine(Directory.GetParent(telemachusDir).FullName, "Certificates", "telemachus_root.cer");
            
            if (!File.Exists(certPath))
            {
                PluginLogger.print("[SSL] Root certificate file not found to trust at: " + certPath);
                return;
            }

            PluginLogger.print("[SSL] Launching system trust prompt via certutil...");
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "certutil.exe",
                    Arguments = $"-user -addstore Root \"{certPath}\"",
                    UseShellExecute = true,
                    CreateNoWindow = false,
                    WindowStyle = ProcessWindowStyle.Normal
                };

                Process.Start(psi);
            }
            catch (Exception ex)
            {
                PluginLogger.print("[SSL] CRITICAL - Failed to launch certutil: " + ex.Message);
            }
        }

        private static void GenerateSelfSignedCerts(ServerConfiguration config, string pfxPath, string rootCerPath)
        {
            // Build a list of SANs formatted as a PowerShell array: "localhost","127.0.0.1",...
            var sans = new List<string> { "\"localhost\"", "\"127.0.0.1\"" };
            foreach (var ip in config.ValidIpAddresses)
            {
                string ipStr = ip.ToString();
                if (ipStr != "127.0.0.1" && ipStr != "0.0.0.0")
                {
                    sans.Add($"\"{ipStr}\"");
                }
            }
            string sanList = string.Join(",", sans);

            string psScript = $@"
$ErrorActionPreference = 'Stop'
$pwd = ConvertTo-SecureString -String '{config.CertificatePassword}' -Force -AsPlainText
$root = New-SelfSignedCertificate -Type Custom -Subject '{ROOT_SUBJECT}' -KeyUsage CertSign -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.19={{text}}CA=1&pathlength=0')
$hostCert = New-SelfSignedCertificate -Type Custom -Subject 'CN=Telemachus Host' -Signer $root -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\CurrentUser\My' -DnsName {sanList}
Export-PfxCertificate -Cert $hostCert -FilePath '{pfxPath}' -Password $pwd
Export-Certificate -Cert $root -FilePath '{rootCerPath}'
$root | Remove-Item
$hostCert | Remove-Item
";

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"" + psScript.Replace("\"", "\\\"").Replace("\r\n", " ") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            };

            using (var process = Process.Start(psi))
            {
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0) throw new Exception("PowerShell Cert Generation Failed: " + error);
                PluginLogger.print("[SSL] PowerShell cert generation successful with SANs: " + sanList);
            }
        }
    }
}
