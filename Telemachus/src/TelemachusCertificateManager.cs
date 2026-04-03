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

        private static bool IsWindows => Environment.OSVersion.Platform != PlatformID.Unix && 
                                         Environment.OSVersion.Platform != PlatformID.MacOSX &&
                                         (int)Environment.OSVersion.Platform != 128; // Older Mono/Unix detection

        public static string GetRootCertPath()
        {
            string telemachusDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            return Path.Combine(Directory.GetParent(telemachusDir).FullName, "Certificates", "telemachus_root.cer");
        }

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

                if (IsWindows)
                {
                    PluginLogger.print("[SSL] Generating new Standalone Certificates via PowerShell...");
                    GenerateSelfSignedCertsWindows(config, pfxPath, rootCerPath);
                }
                else
                {
                    PluginLogger.print("[SSL] Generating new Standalone Certificates via OpenSSL...");
                    GenerateSelfSignedCertsUnix(config, pfxPath, rootCerPath);
                }

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
            if (!IsWindows) return false; // Automatic check only reliable on Windows currently
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

            if (IsWindows)
            {
                PluginLogger.print("[SSL] Launching system trust prompt via certutil...");
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = "certutil.exe",
                        Arguments = $"-user -addstore Root \"{certPath}\"",
                        UseShellExecute = true
                    };
                    Process.Start(psi);
                }
                catch (Exception ex) { PluginLogger.print("[SSL] Failed to launch certutil: " + ex.Message); }
            }
            else if (Environment.OSVersion.Platform == PlatformID.Unix || (int)Environment.OSVersion.Platform == 128)
            {
                bool isMac = Directory.Exists("/Library/Keychains");
                if (isMac)
                {
                    PluginLogger.print("[SSL] Attempting to trust certificate via macOS Keychain...");
                    try
                    {
                        ProcessStartInfo psi = new ProcessStartInfo
                        {
                            FileName = "security",
                            Arguments = $"add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"{certPath}\"",
                            UseShellExecute = true
                        };
                        Process.Start(psi);
                    }
                    catch (Exception ex) { PluginLogger.print("[SSL] macOS trust failed: " + ex.Message); }
                }
                else
                {
                    PluginLogger.print("[SSL] Linux trust requires manual action: sudo cp telemachus_root.cer /usr/local/share/ca-certificates/ && sudo update-ca-certificates");
                }
            }
        }

        private static List<string> GetSanList(ServerConfiguration config, bool dnsPrefix)
        {
            var entries = new List<string> { (dnsPrefix ? "DNS:" : "DNS=") + "localhost", (dnsPrefix ? "IP:" : "IPAddress=") + "127.0.0.1" };
            try { entries.Add((dnsPrefix ? "DNS:" : "DNS=") + System.Net.Dns.GetHostName()); } catch { }
            foreach (var ip in config.ValidIpAddresses)
            {
                string ipStr = ip.ToString();
                if (ipStr != "127.0.0.1" && ipStr != "0.0.0.0" && ipStr != "::1")
                    entries.Add((dnsPrefix ? "IP:" : "IPAddress=") + ipStr);
            }
            return entries;
        }

        private static void GenerateSelfSignedCertsWindows(ServerConfiguration config, string pfxPath, string rootCerPath)
        {
            string sanText = "{text}" + string.Join("&", GetSanList(config, false));

            string psScript = $@"
$ErrorActionPreference = 'Stop'
$pwd = ConvertTo-SecureString -String '{config.CertificatePassword}' -Force -AsPlainText
$root = New-SelfSignedCertificate -Type Custom -Subject '{ROOT_SUBJECT}' -KeyUsage CertSign -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.19={{text}}CA=1&pathlength=0')
$hostCert = New-SelfSignedCertificate -Type Custom -Subject 'CN=Telemachus Host' -Signer $root -KeyExportPolicy Exportable -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.17={sanText}')
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
                PluginLogger.print("[SSL] PowerShell cert generation successful with SAN text: " + sanText);
            }
        }

        private static void GenerateSelfSignedCertsUnix(ServerConfiguration config, string pfxPath, string rootCerPath)
        {
            string certDir = Path.GetDirectoryName(pfxPath);
            string confPath = Path.Combine(certDir, "openssl.conf");
            string rootKeyPath = Path.Combine(certDir, "telemachus_root.key");
            string hostKeyPath = Path.Combine(certDir, "telemachus_host.key");
            string hostCerPath = Path.Combine(certDir, "telemachus_host.cer");

            var sans = GetSanList(config, true);
            string sanString = string.Join(",", sans);

            string confContent = $@"[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
[req_distinguished_name]
[v3_ca]
subjectAltName = {sanString}
basicConstraints = CA:true
";
            File.WriteAllText(confPath, confContent);

            try
            {
                RunCommand("openssl", $"req -x509 -nodes -newkey rsa:2048 -keyout \"{rootKeyPath}\" -out \"{rootCerPath}\" -subj \"/CN=Telemachus Root CA\" -days 3650 -config \"{confPath}\"");
                RunCommand("openssl", $"req -nodes -newkey rsa:2048 -keyout \"{hostKeyPath}\" -out \"{hostCerPath}\" -subj \"/CN=Telemachus Host\" -days 825 -config \"{confPath}\"");
                RunCommand("openssl", $"pkcs12 -export -out \"{pfxPath}\" -inkey \"{hostKeyPath}\" -in \"{hostCerPath}\" -password pass:{config.CertificatePassword}");
            }
            finally
            {
                if (File.Exists(confPath)) File.Delete(confPath);
                if (File.Exists(rootKeyPath)) File.Delete(rootKeyPath);
                if (File.Exists(hostKeyPath)) File.Delete(hostKeyPath);
                if (File.Exists(hostCerPath)) File.Delete(hostCerPath);
            }
        }

        private static void RunCommand(string cmd, string args)
        {
            ProcessStartInfo psi = new ProcessStartInfo { FileName = cmd, Arguments = args, UseShellExecute = false, CreateNoWindow = true };
            using (var process = Process.Start(psi))
            {
                process.WaitForExit();
                if (process.ExitCode != 0) throw new Exception($"Command {cmd} failed with exit code {process.ExitCode}");
            }
        }
    }
}
