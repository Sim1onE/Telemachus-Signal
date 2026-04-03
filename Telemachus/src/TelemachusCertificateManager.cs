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

        public static bool AreCertificateFilesMissing()
        {
            string rootPath = GetRootCertPath();
            string certDir = Path.GetDirectoryName(rootPath);
            string pfxPath = Path.Combine(certDir, "telemachus_host.pfx");
            return !File.Exists(rootPath) || !File.Exists(pfxPath);
        }

        public static X509Certificate2 GetServerCertificate(ServerConfiguration config, bool force = false)
        {
            try
            {
                string telemachusDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
                string certDir = Path.Combine(Directory.GetParent(telemachusDir).FullName, "Certificates");
                PluginLogger.print($"[SSL] Starting cert resolution. Target directory: {certDir}");

                if (!Directory.Exists(certDir)) {
                    PluginLogger.print("[SSL] Certificate directory does not exist, creating it...");
                    Directory.CreateDirectory(certDir);
                }

                string pfxPath = Path.Combine(certDir, "telemachus_host.pfx");
                string rootCerPath = Path.Combine(certDir, "telemachus_root.cer");

                if (force)
                {
                    PluginLogger.print("[SSL] Forced regeneration requested. Deleting old files if they exist...");
                    if (File.Exists(pfxPath)) { PluginLogger.print("[SSL] Deleting old PFX..."); File.Delete(pfxPath); }
                    if (File.Exists(rootCerPath)) { PluginLogger.print("[SSL] Deleting old Root CER..."); File.Delete(rootCerPath); }
                }

                if (File.Exists(pfxPath) && new FileInfo(pfxPath).Length > 0)
                {
                    PluginLogger.print("[SSL] Certificate found on disk. Loading...");
                    var loadedCert = new X509Certificate2(pfxPath, config.CertificatePassword, X509KeyStorageFlags.Exportable | X509KeyStorageFlags.PersistKeySet);
                    PluginLogger.print($"[SSL] Certificate Loaded: {loadedCert.Subject} (Thumbprint={loadedCert.Thumbprint})");
                    return loadedCert;
                }

                if (!force)
                {
                    PluginLogger.print("[SSL] Certificate missing, but no force flag was set. Returning null.");
                    return null;
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

                if (!File.Exists(pfxPath)) {
                    PluginLogger.print("[SSL] FAILED: Post-generation check failed. PFX file not found even though script reported success.");
                    return null;
                }

                var generatedCert = new X509Certificate2(pfxPath, config.CertificatePassword, X509KeyStorageFlags.Exportable | X509KeyStorageFlags.PersistKeySet);
                PluginLogger.print($"[SSL] New Certificate successfully generated and verified in memory. Subject: {generatedCert.Subject}");
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
        private static DateTime _lastCheck = DateTime.MinValue;

        public static void ForceRefreshTrustCheck()
        {
            _needsCheck = true;
        }

        public static bool IsRootTrusted()
        {
            if (!IsWindows) return false;
            
            if (AreCertificateFilesMissing()) return false;

            if (!_needsCheck) return _cachedTrust;

            _needsCheck = false;
            _cachedTrust = false;

            try
            {
                string rootCerPath = GetRootCertPath();
                if (!File.Exists(rootCerPath)) return false;

                // Load the certificate from disk and get its thumbprint
                X509Certificate2 diskCert = new X509Certificate2(rootCerPath);
                string thumbprint = diskCert.Thumbprint.ToUpperInvariant().Replace(" ", "");

                // Use PowerShell for reliable check on Windows/KSP environment
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '" + thumbprint + "' }).Count -gt 0\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true
                };

                using (var process = Process.Start(psi))
                {
                    string output = process.StandardOutput.ReadToEnd().Trim();
                    process.WaitForExit();
                    _cachedTrust = output.Equals("True", StringComparison.OrdinalIgnoreCase);
                    
                    if (_cachedTrust) PluginLogger.print("[SSL] Root CA trust confirmed for thumbprint: " + thumbprint);
                }
            }
            catch (Exception ex)
            {
                PluginLogger.print("[SSL] Error checking trust store: " + ex.Message);
            }

            return _cachedTrust;
        }

        public static void TrustRootCertificate()
        {
            string rootPath = GetRootCertPath();
            if (!File.Exists(rootPath))
            {
                PluginLogger.print("[SSL] Root certificate file not found to trust at: " + rootPath);
                return;
            }

            if (IsWindows)
            {
                PluginLogger.print("[SSL] Launching system trust prompt (cleanup + add) via PowerShell...");
                try
                {
                    // Clean up old Telemachus certificates first to avoid confusion
                    string psCommand = 
                        "$path = '" + rootPath + "'; " +
                        "Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Subject -match 'Telemachus' } | ForEach-Object { certutil -user -delstore Root $_.Thumbprint }; " +
                        "certutil -user -addstore Root $path";

                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = "powershell.exe",
                        Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"" + psCommand + "\"",
                        UseShellExecute = true,
                        CreateNoWindow = true
                    };
                    Process.Start(psi);
                    ForceRefreshTrustCheck();
                }
                catch (Exception ex) { PluginLogger.print("[SSL] Failed to launch trust cleanup/add: " + ex.Message); }
            }
            else if (Environment.OSVersion.Platform == PlatformID.Unix || (int)Environment.OSVersion.Platform == 128)
            {
                bool isMac = Directory.Exists("/Library/Keychains");
                if (isMac)
                {
                    PluginLogger.print("[SSL] Attempting to cleanup and trust certificate via macOS Keychain...");
                    try
                    {
                        // Clean up old Telemachus certs first
                        string cleanupCmd = "security find-certificate -c \"Telemachus\" -a -Z | grep \"SHA-1 hash:\" | awk '{print $NF}' | xargs -n 1 sudo security delete-certificate -Z";
                        string trustCmd = $"sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"{rootPath}\"";
                        
                        ProcessStartInfo psi = new ProcessStartInfo
                        {
                            FileName = "/bin/bash",
                            Arguments = $"-c \"{cleanupCmd}; {trustCmd}\"",
                            UseShellExecute = true
                        };
                        Process.Start(psi);
                    }
                    catch (Exception ex) { PluginLogger.print("[SSL] macOS trust failed: " + ex.Message); }
                }
                else
                {
                    PluginLogger.print("[SSL] Linux trust requires manual action: sudo cp " + Path.GetFileName(rootPath) + " /usr/local/share/ca-certificates/ && sudo update-ca-certificates");
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
                string outMsg = process.StandardOutput.ReadToEnd();
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                
                if (!string.IsNullOrEmpty(outMsg)) PluginLogger.print("[SSL] PowerShell Output: " + outMsg);
                if (!string.IsNullOrEmpty(error)) PluginLogger.print("[SSL] PowerShell Error Stream: " + error);
                
                if (process.ExitCode != 0) {
                    PluginLogger.print($"[SSL] PowerShell FAILED with exit code {process.ExitCode}. Error: {error}");
                    throw new Exception("PowerShell Cert Generation Failed: " + error);
                }
                PluginLogger.print("[SSL] PowerShell cert generation reported success.");
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
