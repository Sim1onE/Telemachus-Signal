using System;
using System.Reflection;
using System.Collections.Generic;
using System.Linq;
using CommNet;
using UnityEngine;

namespace Telemachus
{
    public static class TelemachusSignalManager
    {
        private static bool? _isKerbalismInstalled = null;
        private static Type _kerbalismApiType = null;
        private static MethodInfo _vesselConnectionLinkedMethod = null;
        private static MemberInfo _dampingExponentMember = null;
        private static MethodInfo _blackoutMethod = null;

        public static bool IsKerbalismInstalled
        {
            get
            {
                if (!_isKerbalismInstalled.HasValue)
                {
                    _isKerbalismInstalled = false;
                    foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                    {
                        var name = assembly.GetName().Name;
                        if (name.IndexOf("Kerbalism", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            UnityEngine.Debug.Log("[Telemachus] Scanning Assembly: " + name);
                            foreach (var type in GetSafeTypes(assembly))
                            {
                                // Main API
                                if (type.FullName == "KERBALISM.API")
                                {
                                    _kerbalismApiType = type;
                                    _isKerbalismInstalled = true;
                                    _vesselConnectionLinkedMethod = _kerbalismApiType.GetMethod("VesselConnectionLinked", new[] { typeof(Vessel) });
                                    _blackoutMethod = _kerbalismApiType.GetMethod("Blackout", new[] { typeof(Vessel) });
                                    UnityEngine.Debug.Log("[Telemachus] Found Kerbalism API in: " + name);
                                }
                                // Damping Exponent in Sim (Property or Field)
                                if (type.FullName == "KERBALISM.Sim")
                                {
                                    _dampingExponentMember = (MemberInfo)type.GetProperty("DataRateDampingExponent", BindingFlags.Public | BindingFlags.Static)
                                                            ?? (MemberInfo)type.GetField("DataRateDampingExponent", BindingFlags.Public | BindingFlags.Static)
                                                            ?? (MemberInfo)type.GetProperty("DataRateDampingExponentRT", BindingFlags.Public | BindingFlags.Static)
                                                            ?? (MemberInfo)type.GetField("DataRateDampingExponentRT", BindingFlags.Public | BindingFlags.Static);

                                    if (_dampingExponentMember != null)
                                        UnityEngine.Debug.Log("[Telemachus] Found Damping Exponent (" + _dampingExponentMember.Name + ") in: " + name);
                                }
                            }
                        }
                    }
                    if (_isKerbalismInstalled.Value)
                    {
                        UnityEngine.Debug.Log("[Telemachus] Kerbalism Integration: ACTIVE (Formula Mode)");
                    }
                    else
                    {
                        UnityEngine.Debug.Log("[Telemachus] Kerbalism Integration: NOT FOUND (Checked all assemblies)");
                    }
                }
                return _isKerbalismInstalled.Value;
            }
        }

        private static IEnumerable<Type> GetSafeTypes(Assembly assembly)
        {
            try { return assembly.GetTypes(); }
            catch (ReflectionTypeLoadException e) { return e.Types.Where(t => t != null); }
            catch (Exception) { return new Type[0]; }
        }

        public static double GetActualSignalStrength(Vessel v)
        {
            if (v == null) return 0;
            double stock = GetStockSignalStrength(v);

            if (IsKerbalismInstalled)
            {
                try
                {
                    // 1. Linked check
                    bool linked = false;
                    if (_vesselConnectionLinkedMethod != null)
                    {
                        object linkedObj = _vesselConnectionLinkedMethod.Invoke(null, new object[] { v });
                        if (linkedObj != null) linked = (bool)linkedObj;
                    }

                    if (!linked) return 0;

                    // 2. Blackout check (Storms)
                    if (_blackoutMethod != null)
                    {
                        object blackoutObj = _blackoutMethod.Invoke(null, new object[] { v });
                        if (blackoutObj != null && (bool)blackoutObj) return 0;
                    }

                    // 3. Damping Formula: Strength = Math.Pow(Stock, Exponent)
                    if (_dampingExponentMember != null)
                    {
                        double exponent = 1.0;
                        if (_dampingExponentMember is PropertyInfo pi) exponent = Convert.ToDouble(pi.GetValue(null, null));
                        else if (_dampingExponentMember is FieldInfo fi) exponent = Convert.ToDouble(fi.GetValue(null));

                        if (exponent > 0.001)
                        {
                            return Math.Pow(stock, exponent);
                        }
                    }
                }
                catch (Exception e)
                {
                    UnityEngine.Debug.Log("[Telemachus] Kerbalism Formula Error: " + e.Message);
                }
            }

            return stock;
        }

        /// <summary>
        /// Returns the stock CommNet signal strength for a vessel (0.0 to 1.0)
        /// </summary>
        public static double GetStockSignalStrength(Vessel v)
        {
            if (v != null && v.connection != null)
            {
                return v.connection.SignalStrength;
            }
            return 0;
        }

        /// <summary>
        /// Returns true if Kerbalism says the vessel is connected, false if disconnected.
        /// Returns null if Kerbalism is not installed (so caller knows to skip).
        /// </summary>
        public static bool? IsKerbalismLinked(Vessel v)
        {
            if (v == null) return null;
            if (!IsKerbalismInstalled || _vesselConnectionLinkedMethod == null) return null;

            try
            {
                object result = _vesselConnectionLinkedMethod.Invoke(null, new object[] { v });
                return result != null ? (bool)result : (bool?)null;
            }
            catch (Exception e)
            {
                UnityEngine.Debug.Log("[Telemachus] Error reading Kerbalism linked status: " + e.Message);
                return null;
            }
        }

        public static double GetTotalPathDistance(Vessel v)
        {
            if (v == null || v.connection == null || v.connection.ControlPath == null) 
                return 0;

            double totalDistance = 0;
            foreach (CommLink link in v.connection.ControlPath)
            {
                totalDistance += (link.start.position - link.end.position).magnitude;
            }

            return totalDistance;
        }

        public static double GetSignalDelay(Vessel v)
        {
            if (v == null || v.connection == null) return 0;

            // Average round trip time / 2
            // Sum of link delays in path
            double totalDelay = 0;
            try
            {
                foreach (CommLink link in v.connection.ControlPath)
                {
                    // Case-insensitive check for signalDelay property or field
                    var delayMember = typeof(CommLink).GetProperty("signalDelay", BindingFlags.Public | BindingFlags.Instance)
                                   ?? typeof(CommLink).GetProperty("SignalDelay", BindingFlags.Public | BindingFlags.Instance)
                                   ?? (MemberInfo)typeof(CommLink).GetField("signalDelay", BindingFlags.Public | BindingFlags.Instance);
                    
                    if (delayMember != null)
                    {
                        if (delayMember is PropertyInfo pi) totalDelay += Convert.ToDouble(pi.GetValue(link, null));
                        else if (delayMember is FieldInfo fi) totalDelay += Convert.ToDouble(fi.GetValue(link));
                    }
                }
            } catch {}

            if (totalDelay > 0) return totalDelay;

            // Fallback: Path Distance / c
            double distance = GetTotalPathDistance(v);
            return distance / 299792458.0;
        }
    }
}
