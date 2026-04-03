using UnityEngine;
using System;
using System.Linq;

namespace Telemachus
{
    public static class AudioCaptureManager
    {
        public static string SelectedDevice { get; private set; } = null;
        public static bool IsInitialized { get; private set; } = false;

        public static void Initialize()
        {
            if (Microphone.devices.Length > 0)
            {
                // Fallback to the first available device if no device is selected
                if (string.IsNullOrEmpty(SelectedDevice) || !Microphone.devices.Contains(SelectedDevice))
                {
                    SelectedDevice = Microphone.devices[0];
                }
                IsInitialized = true;
            }
        }

        public static void SetDevice(string deviceName)
        {
            if (Microphone.devices.Contains(deviceName))
            {
                SelectedDevice = deviceName;
                PluginLogger.print($"[Audio] Microphone device changed to: {deviceName}");
                // Broadcast change if necessary, or let sessions poll/re-start
            }
        }

        public static string[] GetDevices()
        {
            return Microphone.devices;
        }
    }
}
