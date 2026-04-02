using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text;


namespace Telemachus
{

    public class ServerConfiguration
    {
        public string version { get; set; }
        public string name { get; set; }
        public int port { get; set; } = 8085;
        /// <summary>The IP Address configured in the Telemachus plugin configuration</summary>
        public IPAddress ipAddress { get; set; } = IPAddress.Any;
        /// <summary>A list of IP Addresses that the server should be accessible at</summary>
        public List<IPAddress> ValidIpAddresses { get; set; } = new();

        // --- SSL / HTTPS ---
        public bool UseSsl { get; set; } = false;
        public string CertificatePath { get; set; } = "";
        public string CertificatePassword { get; set; } = "telemachus";
        public bool AutoGenerateSsl { get; set; } = true;
        public bool HasPromptedSsl { get; set; } = false;
    }

    internal static class ServerConfigExtensions
    {
        internal static bool IsPortNumber(this int value)
        {
            return value > 0 && value < 65536;
        }
    }
}