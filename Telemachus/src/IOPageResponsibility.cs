//Author: Richard Bunt

using System;
using System.Collections.Generic;
using System.Text;
using WebSocketSharp.Net;
using WebSocketSharp;
using KSP.IO;
using System.IO;

namespace Telemachus
{
    class IOPageResponsibility : IHTTPRequestResponder
    {
        #region Constants

        const String PAGE_PREFIX = "/telemachus";

        #endregion

        #region IHTTPRequestResponder

        public bool process(HttpListenerRequest request, HttpListenerResponse response)
        {
            string url = request.RawUrl;
            
            // Normalize root and prefix using a REAL 302 redirect
            if (url == "/" || url == "/telemachus" || url == "/telemachus/") {
                response.Redirect("/telemachus/index.html");
                return true;
            }

            if (url.StartsWith(PAGE_PREFIX))
            {
                try
                {
                    // Strip query strings (e.g. index.html?v=1)
                    if (url.Contains("?")) url = url.Split('?')[0];

                    string requestedFile = url.Substring(PAGE_PREFIX.Length);
                    // Remove leading slash to avoid double-slashes with the PluginData path
                    if (requestedFile.StartsWith("/")) requestedFile = requestedFile.Substring(1);
                    if (string.IsNullOrEmpty(requestedFile)) requestedFile = "index.html";

                    var contentType = GetContentType(Path.GetExtension(requestedFile));

                    // CORS for static files
                    response.AddHeader("Access-Control-Allow-Origin", "*");

                    var localPath = buildPath(escapeFileName(requestedFile));
                    PluginLogger.print(string.Format("[IO] Serving {0} -> {1}", url, localPath));

                    if (!System.IO.File.Exists(localPath))
                    {
                        PluginLogger.print(string.Format("[IO] ERROR: File NOT Found on Disk: {0}", localPath));
                        return false;
                    }

                    byte[] contentData = System.IO.File.ReadAllBytes(localPath);
                    if (contentType.contentType == HTMLContentType.TextContent)
                    {
                        response.ContentEncoding = Encoding.UTF8;
                    }
                    response.WriteContent(contentData);

                    return true;
                }
                catch (Exception ex)
                {
                    PluginLogger.print(string.Format("[IO] ERROR processing {0}: {1}", url, ex.Message));
                }
            }
            return false;
        }

        #endregion

        #region Content Type Determination

        /// Retrieve whether a specific extension is text, binary, and what it's mimetype is.
        private enum HTMLContentType
        {
            TextContent,
            BinaryContent,
        }
        private struct HTMLResponseContentType
        {
            public HTMLContentType contentType;
            public string mimeType;
        }
        private Dictionary<string, HTMLResponseContentType> contentTypes = null;
        private HTMLResponseContentType GetContentType(string extension)
        {
            contentTypes ??= new Dictionary<string, HTMLResponseContentType>
            {
                [".html"] = new HTMLResponseContentType { contentType = HTMLContentType.TextContent, mimeType = "text/html" },
                [".css"] = new HTMLResponseContentType { contentType = HTMLContentType.TextContent, mimeType = "text/css" },
                [".js"] = new HTMLResponseContentType { contentType = HTMLContentType.TextContent, mimeType = "application/x-javascript" },
                [".jpg"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "image/jpeg" },
                [".jpeg"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "image/jpeg" },
                [".png"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "image/png" },
                [".gif"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "image/gif" },
                [".svg"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "image/svg+xml" },
                [".eot"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "application/vnd.ms-fontobject" },
                [".ttf"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "application/font-sfnt" },
                [".woff"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "application/font-woff" },
                [".otf"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "application/font-sfnt" },
                [".mp4"] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = "video/mp4" },
                [".json"] = new HTMLResponseContentType { contentType = HTMLContentType.TextContent, mimeType = "application/json" },
                [".txt"] = new HTMLResponseContentType { contentType = HTMLContentType.TextContent, mimeType = "text/plain" },
                [""] = new HTMLResponseContentType { contentType = HTMLContentType.BinaryContent, mimeType = null },
            };

            return contentTypes.TryGetValue(extension, out var ct) ? ct : contentTypes[""];
        }

        #endregion

        #region Methods

        static protected string buildPath(string fileName)
        {
            string assemblyPath = System.Reflection.Assembly.GetExecutingAssembly().Location;
            const string webFiles = "PluginData/Telemachus/";
            return assemblyPath.Replace("Telemachus.dll", "") + webFiles + fileName;
        }

        static protected string escapeFileName(string fileName)
        {
            return fileName.Replace("..", "");
        }

        #endregion
    }
}
