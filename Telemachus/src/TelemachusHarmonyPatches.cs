using System;
using System.IO;
using System.Reflection;
using System.Linq;
using System.Collections.Generic;
using HarmonyLib;
using UnityEngine;
using UnityEngine.UI;

namespace Telemachus.Harmony
{
    [KSPAddon(KSPAddon.Startup.EveryScene, false)]
    public class TelemachusHarmonyLoader : MonoBehaviour
    {
        private static bool _patchedUI = false;
        private static bool _patchedTelemetry = false;
        private static bool _kerbalismFound = false;

        private float nextCheck = 0f;
        private bool patchesFinalized = false;

        void Awake() { InitializePatches("Awake"); }

        void Update()
        {
            if (!_kerbalismFound && Time.time > nextCheck)
            {
                nextCheck = Time.time + 5f;
                if (TelemachusSignalManager.IsKerbalismInstalled)
                {
                    _kerbalismFound = true;
                    UnityEngine.Debug.Log("[Telemachus] Kerbalism detected! Finalizing UI overrides...");
                    InitializePatches("RUNTIME");
                }
            }
        }

        public void InitializePatches(string scene)
        {
            if (patchesFinalized && scene != "RUNTIME") return;
            UnityEngine.Debug.Log(string.Format("[Telemachus] *** UI SYNC ENGINE v8.0-PNG (Scene: {0}) ***", scene));

            try
            {
                var harmony = new HarmonyLib.Harmony("com.telemachus.signal.v55");

                if (!_patchedUI)
                {
                    _patchedUI = PatchUIComponent(harmony, "CommNetUI", new[] { "UpdateDisplay", "Update" });
                }

                if (!_patchedTelemetry)
                {
                    _patchedTelemetry = PatchUIComponent(harmony, "TelemetryUpdate", new[] { "Update", "LateUpdate" });
                }

                patchesFinalized = true;
            }
            catch (Exception e) { UnityEngine.Debug.LogError("[Telemachus] CRITICAL ERROR: " + e); }
        }

        private bool PatchUIComponent(HarmonyLib.Harmony harmony, string typeName, string[] targets)
        {
            Type t = FindType(typeName);
            if (t == null) return false;

            var allMethods = t.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            bool success = false;
            foreach (var name in targets)
            {
                var targetMethod = allMethods.FirstOrDefault(m => m.Name == name);
                if (targetMethod != null)
                {
                    var postfix = typeof(PatchUIBase).GetMethod("Postfix", BindingFlags.Static | BindingFlags.Public);
                    harmony.Patch(targetMethod, null, new HarmonyMethod(postfix, Priority.Last));
                    success = true;
                    UnityEngine.Debug.Log("[Telemachus] SUCCESS: Patch applied for " + typeName + "." + name);
                }
            }
            return success;
        }

        public static Type FindType(string typeName)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    foreach (var type in GetSafeTypes(assembly))
                    {
                        if (type.Name == typeName || type.FullName == typeName) return type;
                    }
                }
                catch { }
            }
            return null;
        }

        private static Type[] GetSafeTypes(Assembly assembly)
        {
            try { return assembly.GetTypes(); }
            catch (ReflectionTypeLoadException e) { return e.Types.Where(t => t != null).ToArray(); }
            catch { return new Type[0]; }
        }
    }

    public static class PatchUIBase
    {
        private static float lastLog = 0f;
        private static bool wasOverridden = false;
        private static int callCount = 0;

        // Configuration
        private const string TEXTURE_PATH = "GameData/Telemachus/Textures";

        // Cache for loaded custom sprites
        private static Dictionary<string, Sprite> customSpriteCache = new Dictionary<string, Sprite>();

        public static void Postfix(MonoBehaviour __instance)
        {
            if (FlightGlobals.ActiveVessel == null) return;

            try
            {
                callCount++;
                Vessel v = FlightGlobals.ActiveVessel;
                
                // Get connection states
                bool? kerbalismLinked = TelemachusSignalManager.IsKerbalismLinked(v);
                double stockStrength = TelemachusSignalManager.GetStockSignalStrength(v);
                double actualStrength = TelemachusSignalManager.GetActualSignalStrength(v);

                Image signalIcon = GetSignalIcon(__instance);
                if (signalIcon == null) return;

                // Logging: Increased frequency and detail for diagnosis
                bool shouldLog = callCount <= 10 || Time.time > lastLog + 10f;
                if (shouldLog)
                {
                    lastLog = Time.time;
                    UnityEngine.Debug.Log(string.Format(
                        "[Telemachus] UI Sync Status: KerbalismLinked={0}, StockStrength={1:F3}, ActualStrength={2:F3}, Overridden={3}",
                        kerbalismLinked.HasValue ? kerbalismLinked.Value.ToString() : "N/A", 
                        stockStrength, actualStrength, wasOverridden));
                }

                // If Kerbalism is not installed, leave Stock alone
                if (!kerbalismLinked.HasValue) return;

                // Logic: 
                // 1. If kerbalism is not linked -> Null variant of current stock bars
                // 2. If actual strength < stock strength -> Lower variant of current stock bars
                // 3. Otherwise -> Stock behavior
                
                string variant = null;
                // Get linked status explicitly
                bool linked = kerbalismLinked.Value;

                if (!linked)
                {
                    variant = "Null";
                    if (shouldLog) UnityEngine.Debug.Log("[Telemachus] UI State: Selecting NULL (Kerbalism OFFLINE)");
                }
                else if (actualStrength < stockStrength - 0.05)
                {
                    variant = "Lower";
                    if (shouldLog) UnityEngine.Debug.Log("[Telemachus] UI State: Selecting LOWER (Degraded Signal vs Stock)");
                }
                else
                {
                    if (shouldLog && wasOverridden) UnityEngine.Debug.Log("[Telemachus] UI State: RESTORING Stock (Healthy Sync)");
                }

                if (variant != null)
                {
                    string ssKey = GetSSKeyForSignalStrength(stockStrength);
                    Sprite customSprite = GetCustomSprite(ssKey, variant);
                    
                    if (customSprite != null)
                    {
                        signalIcon.sprite = customSprite;
                        // For custom PNGs, we use white color to show them exactly as they are
                        signalIcon.color = new Color(1f, 1f, 1f, signalIcon.color.a);
                        wasOverridden = true;
                    }
                }
                else if (wasOverridden)
                {
                    // Reset to stock color - KSP will handle the sprite swap naturally on its next tick
                    signalIcon.color = new Color(1f, 1f, 1f, signalIcon.color.a);
                    wasOverridden = false;
                }

                InjectTooltipText(__instance, kerbalismLinked.Value);
            }
            catch (Exception e)
            {
                UnityEngine.Debug.LogError("[Telemachus] Postfix Error: " + e.Message + "\n" + e.StackTrace);
            }
        }

        private static Sprite GetCustomSprite(string ssKey, string variant)
        {
            // Map SS key to the suffix used in filenames
            string spriteSuffix = "";
            switch (ssKey)
            {
                case "SS0": spriteSuffix = "Comm_Bars_None"; break;
                case "SS1": spriteSuffix = "Comm_Bars_Red"; break;
                case "SS2": spriteSuffix = "Comm_Bars_Orange"; break;
                case "SS3": spriteSuffix = "Comm_Bars_Yellow"; break;
                case "SS4": spriteSuffix = "Comm_Bars_Green"; break;
                default: return null;
            }

            string filename = string.Format("{0}_{1}_{2}.png", ssKey, variant, spriteSuffix);
            string cacheKey = filename;

            if (customSpriteCache.ContainsKey(cacheKey))
                return customSpriteCache[cacheKey];

            // Load from file
            try
            {
                string fullPath = Path.Combine(KSPUtil.ApplicationRootPath, TEXTURE_PATH, filename);
                if (!File.Exists(fullPath))
                {
                    UnityEngine.Debug.LogWarning("[Telemachus] Custom sprite not found: " + fullPath);
                    customSpriteCache[cacheKey] = null;
                    return null;
                }

                byte[] fileData = File.ReadAllBytes(fullPath);
                Texture2D tex = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (tex.LoadImage(fileData))
                {
                    // Create sprite from texture
                    Sprite sprite = Sprite.Create(
                        tex, 
                        new Rect(0, 0, tex.width, tex.height), 
                        new Vector2(0.5f, 0.5f), 
                        100.0f); // Standard PPU
                    
                    sprite.name = cacheKey;
                    customSpriteCache[cacheKey] = sprite;
                    UnityEngine.Debug.Log("[Telemachus] Loaded custom sprite: " + cacheKey);
                    return sprite;
                }
            }
            catch (Exception e)
            {
                UnityEngine.Debug.LogError("[Telemachus] Failed to load custom sprite " + filename + ": " + e.Message);
            }

            customSpriteCache[cacheKey] = null;
            return null;
        }

        private static Image GetSignalIcon(MonoBehaviour instance)
        {
            var f = instance.GetType().GetField("signal_icon",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            return f != null ? f.GetValue(instance) as Image : null;
        }

        private static string GetSSKeyForSignalStrength(double sig)
        {
            if (sig <= 0.01) return "SS0";
            if (sig < 0.25) return "SS1";
            if (sig < 0.50) return "SS2";
            if (sig < 0.75) return "SS3";
            return "SS4";
        }

        private static void InjectTooltipText(MonoBehaviour instance, bool linked)
        {
            try
            {
                var f = instance.GetType().GetField("signal_tooltip",
                    BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                if (f == null) return;
                var ctrl = f.GetValue(instance);
                if (ctrl == null) return;
                var tp = ctrl.GetType().GetProperty("TooltipText")
                    ?? ctrl.GetType().GetProperty("text");
                if (tp == null) return;
                string cur = tp.GetValue(ctrl) as string;
                if (cur != null && !cur.Contains("[TELEMACHUS]"))
                {
                    string hex = linked ? "44FF44" : "FF4444";
                    string s = linked ? "LINKED" : "OFFLINE";
                    tp.SetValue(ctrl, cur + string.Format(
                        "\n<color=#{0}><b>[TELEMACHUS]</b> Kerbalism: {1}</color>", hex, s));
                }
            }
            catch { }
        }
    }
}
