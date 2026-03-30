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

                // Apply all attributed patches (like PatchTooltipSignalStrength)
                harmony.PatchAll(Assembly.GetExecutingAssembly());

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
        private static float lastDump = 0f;

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
                bool? transmissionLinked = TelemachusSignalManager.IsTransmissionLinked(v);
                double stock = TelemachusSignalManager.GetSignalStrength(v);
                double actual = TelemachusSignalManager.GetSignalQuality(v);

                Image signalIcon = GetSignalIcon(__instance);
                if (signalIcon == null) return;

                // Logging
                bool shouldLog = callCount <= 10 || Time.time > lastLog + 10f;
                if (shouldLog)
                {
                    lastLog = Time.time;
                    UnityEngine.Debug.Log(string.Format(
                        "[Telemachus] UI Sync Status: KerbalismLinked={0}, StockStrength={1:F3}, ActualStrength={2:F3}, Overridden={3}",
                        transmissionLinked.HasValue ? transmissionLinked.Value.ToString() : "N/A",
                        stock, actual, wasOverridden));
                }

                // If Kerbalism is not installed, leave Stock alone
                if (!transmissionLinked.HasValue) return;

                string variant = null;
                bool linked = transmissionLinked.Value;

                if (!linked)
                {
                    variant = "Null";
                    if (shouldLog) UnityEngine.Debug.Log("[Telemachus] UI State: Selecting NULL (Kerbalism OFFLINE)");
                }
                else if (actual < stock - 0.05)
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
                    string ssKey = GetSSKeyForSignalStrength(stock);
                    Sprite customSprite = GetCustomSprite(ssKey, variant);

                    if (customSprite != null)
                    {
                        signalIcon.sprite = customSprite;
                        signalIcon.color = new Color(1f, 1f, 1f, signalIcon.color.a);
                        wasOverridden = true;
                    }
                }
                else if (wasOverridden)
                {
                    signalIcon.color = new Color(1f, 1f, 1f, signalIcon.color.a);
                    wasOverridden = false;
                }
            }
            catch (Exception e)
            {
                UnityEngine.Debug.LogError("[Telemachus] Postfix Error: " + e.Message + "\n" + e.StackTrace);
            }
        }

        private static Sprite GetCustomSprite(string ssKey, string variant)
        {
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
                    Sprite sprite = Sprite.Create(
                        tex,
                        new Rect(0, 0, tex.width, tex.height),
                        new Vector2(0.5f, 0.5f),
                        100.0f);

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
            if (sig <= 0.00) return "SS0";
            if (sig < 0.25) return "SS1";
            if (sig < 0.50) return "SS2";
            if (sig < 0.75) return "SS3";
            return "SS4";
        }
    }

    [HarmonyPatch]
    public class PatchTooltipSignalStrength
    {
        static MethodBase TargetMethod()
        {
            Type t = TelemachusSignalManager.FindType("CommNet.TooltipController_SignalStrength");
            if (t == null) return null;
            return t.GetMethod("UpdateList", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        }

        public static void Postfix(MonoBehaviour __instance)
        {
            if (FlightGlobals.ActiveVessel == null) return;

            double quality = TelemachusSignalManager.GetSignalQuality(FlightGlobals.ActiveVessel);
            double delay = TelemachusSignalManager.GetSignalDelay(FlightGlobals.ActiveVessel);

            InjectTooltip(__instance, quality, delay);
        }

        private static void InjectTooltip(MonoBehaviour ctrl, double quality, double delay)
        {
            try
            {
                // --- HEADER-MERGE STRATEGY ---
                var windowField = ctrl.GetType().GetField("tooltip", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                var windowInstance = windowField?.GetValue(ctrl) as MonoBehaviour;

                if (windowInstance != null)
                {
                    foreach (var textComp in windowInstance.GetComponentsInChildren<MonoBehaviour>(true))
                    {
                        if (textComp.GetType().Name.Contains("TextMeshPro"))
                        {
                            var textProp = textComp.GetType().GetProperty("text");
                            string currentText = textProp?.GetValue(textComp, null) as string;

                            if (!string.IsNullOrEmpty(currentText) && currentText.Contains("Signal Strength"))
                            {
                                if (currentText.Contains("Transmission Quality")) return;

                                string qualityText = string.Format("\n<size=85%><color=#00FFFF>Transmission Quality: {0:P0}</color></size>", quality);

                                string delayText = "";
                                if (delay > 0)
                                {
                                    string delayFormatted = delay >= 1.0
                                        ? string.Format("{0:F2}s", delay)
                                        : string.Format("{0:F0}ms", delay * 1000.0);
                                    delayText = string.Format("\n<size=85%><color=#FF00FF>Signal Delay: {0}</color></size>", delayFormatted);
                                }

                                textProp?.SetValue(textComp, currentText + qualityText + delayText, null);
                                break;
                            }
                        }
                    }
                }
            }
            catch { }
        }
    }
}
