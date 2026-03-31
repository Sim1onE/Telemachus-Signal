using UnityEngine;
using System;
using Telemachus.CameraSnapshots;

namespace Telemachus.Debug
{
    [KSPAddon(KSPAddon.Startup.Flight, false)]
    public class TelemachusDebugToolbar : MonoBehaviour
    {
        private Rect windowRect = new Rect(100, 100, 250, 250);
        private bool isVisible = false;

        private float sigOverrideValue = 1.0f;
        private bool sigOverrideEnabled = false;

        private float delayOverrideValue = 0.0f;
        private bool delayOverrideEnabled = false;

        private void Update()
        {
            // Toggle visibility with Alt + T
            if (Input.GetKey(KeyCode.LeftAlt) && Input.GetKeyDown(KeyCode.T))
            {
                isVisible = !isVisible;
            }
        }

        private void OnGUI()
        {
            if (!isVisible) return;

            windowRect = GUILayout.Window(99123, windowRect, DrawWindow, "TELEMACHUS DEBUG (Houston)");
        }

        private void DrawWindow(int windowID)
        {
            GUILayout.BeginVertical();

            // --- SIGNAL SECTION ---
            GUILayout.Label("SIGNAL STRENGTH (Link Quality)");
            sigOverrideEnabled = GUILayout.Toggle(sigOverrideEnabled, "Override Strength");

            if (sigOverrideEnabled)
            {
                sigOverrideValue = GUILayout.HorizontalSlider(sigOverrideValue, 0.0f, 1.0f);
                GUILayout.Label($"Forced: {(sigOverrideValue * 100f).ToString("F0")}%");
                CameraCapture.DebugSignalOverride = sigOverrideValue;
            }
            else
            {
                CameraCapture.DebugSignalOverride = -1f;
                GUILayout.Label("Using CommNet Strength");
            }

            GUILayout.Space(10);

            // --- DELAY SECTION ---
            GUILayout.Label("SIGNAL DELAY (Latency)");
            delayOverrideEnabled = GUILayout.Toggle(delayOverrideEnabled, "Override Delay");

            if (delayOverrideEnabled)
            {
                delayOverrideValue = GUILayout.HorizontalSlider(delayOverrideValue, 0.0f, 30.0f);
                GUILayout.Label($"Forced Delay: {delayOverrideValue.ToString("F1")}s");
                CameraCapture.DebugDelayOverride = delayOverrideValue;
            }
            else
            {
                CameraCapture.DebugDelayOverride = -1f;
                GUILayout.Label("Using CommNet Delay");
            }

            GUILayout.Space(10);
            if (GUILayout.Button("CLOSE (Alt+T)")) isVisible = false;

            GUILayout.EndVertical();
            GUI.DragWindow();
        }
    }
}
