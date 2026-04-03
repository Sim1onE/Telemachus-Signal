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
            string url = request.RawUrl.ToLower();
            if (url.Contains("?")) url = url.Split('?')[0];

            // Normalize URL: treat it as relative to Telemachus folder whether or not prefix is present
            string relativePath = url;
            if (relativePath.StartsWith(PAGE_PREFIX)) 
                relativePath = relativePath.Substring(PAGE_PREFIX.Length);
            
            if (relativePath.StartsWith("/")) relativePath = relativePath.Substring(1);
            if (string.IsNullOrEmpty(relativePath)) relativePath = "index.html";

            string localPath = buildPath(escapeFileName(relativePath));

            // Search Order:
            // 1. Direct match (e.g. /telemachus/js/app.js OR /js/app.js -> js/app.js)
            if (System.IO.File.Exists(localPath)) return serve(localPath, response);
            
            // 2. HTML Fallback (e.g. /telemachus/dashboard -> dashboard.html)
            if (System.IO.File.Exists(localPath + ".html")) return serve(localPath + ".html", response);
            
            // 3. Directory Index Fallback (e.g. /telemachus/communications -> communications/index.html)
            string indexPath = System.IO.Path.Combine(localPath, "index.html");
            if (System.IO.File.Exists(indexPath)) return serve(indexPath, response);

            // 4. SMART CONTEXT FALLBACK (The "Referer" Trick)
            // If we still didn't find the file, check if the browser is requesting an asset 
            // from a page that was accessed without a trailing slash.
            if (request.UrlReferrer != null)
            {
                string referrerPath = request.UrlReferrer.AbsolutePath.ToLower();
                if (referrerPath.StartsWith(PAGE_PREFIX))
                {
                    string contextFolder = referrerPath.Substring(PAGE_PREFIX.Length);
                    if (contextFolder.StartsWith("/")) contextFolder = contextFolder.Substring(1);
                    
                    // If the referrer looks like a directory (no extension), try looking inside it
                    if (!contextFolder.Contains(".") && !string.IsNullOrEmpty(contextFolder))
                    {
                        string retryPath = System.IO.Path.Combine(buildPath(contextFolder), relativePath);
                        if (System.IO.File.Exists(retryPath))
                        {
                             PluginLogger.print("[IO] Context hit: " + relativePath + " found in referrer context: " + contextFolder);
                             return serve(retryPath, response);
                        }
                    }
                }
            }

            return false;
        }

        private bool serve(string localPath, HttpListenerResponse response)
        {
            try
            {
                var filename = System.IO.Path.GetFileName(localPath);
                var contentType = GetContentType(System.IO.Path.GetExtension(localPath).ToLower());
                
                byte[] contentData = System.IO.File.ReadAllBytes(localPath);
                response.AddHeader("Access-Control-Allow-Origin", "*");
                
                if (contentType.contentType == HTMLContentType.TextContent) 
                    response.ContentEncoding = Encoding.UTF8;
                
                if (contentType.mimeType != null) 
                    response.ContentType = contentType.mimeType;

                response.WriteContent(contentData);
                return true;
            }
            catch (Exception ex)
            {
                PluginLogger.print("[IO] Error serving file: " + ex.Message);
                return false;
            }
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
                [".js"] = new HTMLResponseContentType { contentType = HTMLContentType.TextContent, mimeType = "application/javascript" },
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
