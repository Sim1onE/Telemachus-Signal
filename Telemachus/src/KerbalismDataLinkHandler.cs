using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Linq;

namespace Telemachus
{
    /// <summary>
    /// Exposes life support, radiation, habitat, crew health, comms, science,
    /// and space weather data from Kerbalism.
    /// Kerbalism provides a public static API class (KERBALISM.API) designed
    /// for reflection-based access. Deeper data comes from VesselData, DB,
    /// and Storm classes.
    /// All access is via reflection — soft dependency.
    /// </summary>
    public class KerbalismDataLinkHandler : DataLinkHandler
    {
        static bool _searched;

        // KERBALISM.API — public static methods for mod interop
        static Type _apiType;

        // KERBALISM.Features — feature flags
        static Type _featuresType;

        // KERBALISM.DB — database access
        static Type _dbType;
        static MethodInfo _dbStormMethod;   // DB.Storm(string body_name)
        static MethodInfo _dbKerbalMethod;  // DB.Kerbal(string name)

        // KERBALISM.StormData
        static Type _stormDataType;
        static FieldInfo _stormStateField;
        static FieldInfo _stormTimeField;
        static FieldInfo _stormDurationField;

        // KERBALISM.KerbalData
        static Type _kerbalDataType;
        static FieldInfo _kerbalRulesField;  // Dictionary<string, RuleData>

        // VesselData extension method & properties
        static Type _vesselDataType;
        static MethodInfo _kerbalismDataMethod;  // Vessel.KerbalismData() extension
        static PropertyInfo _vdEnvTemperature;
        static PropertyInfo _vdEnvTempDiff;
        static PropertyInfo _vdEnvStormRadiation;
        static PropertyInfo _vdEnvBreathable;
        static PropertyInfo _vdEnvInAtmosphere;
        static PropertyInfo _vdCrewCount;
        static PropertyInfo _vdCrewCapacity;
        static PropertyInfo _vdMalfunction;
        static PropertyInfo _vdCritical;
        static PropertyInfo _vdSolarPanelExposure;
        static PropertyInfo _vdDrivesFreeSpace;
        static PropertyInfo _vdDrivesCapacity;

        // ConnectionInfo
        static PropertyInfo _vdConnection;
        static Type _connectionInfoType;

        // KERBALISM.ResourceCache
        static Type _resCacheType;
        static MethodInfo _resCacheGetMethod;

        // KERBALISM.VesselCache
        static Type _vesselCacheType;
        static FieldInfo _vesselCacheResourcesField;

        static readonly Dictionary<string, MethodInfo> _apiMethods = new();

        public KerbalismDataLinkHandler(FormatterProvider formatters)
            : base(formatters) { }

        static Type TryGetType(string name)
        {
            foreach (var asm in AssemblyLoader.loadedAssemblies)
            {
                // Try Kerbalism (Modern) and KERBALISM (Legacy)
                var type = asm.assembly.GetType("Kerbalism." + name, false) 
                          ?? asm.assembly.GetType("KERBALISM." + name, false);
                if (type != null) return type;
            }
            return null;
        }

        static void Search()
        {
            if (_searched) return;
            _searched = true;

            _apiType = TryGetType("API");
            _featuresType = TryGetType("Features");
            _dbType = TryGetType("DB");
            _stormDataType = TryGetType("StormData");
            _kerbalDataType = TryGetType("KerbalData");
            _vesselDataType = TryGetType("VesselData");
            _connectionInfoType = TryGetType("ConnectionInfo");
            _resCacheType = TryGetType("ResourceCache");
            _vesselCacheType = TryGetType("VesselCache");

            if (_apiType == null)
            {
                PluginLogger.debug("Kerbalism not found");
                return;
            }

            PluginLogger.debug("Kerbalism detected: " + _apiType.Assembly.GetName().Version);

            var pub = BindingFlags.Public | BindingFlags.Static;
            var pubInst = BindingFlags.Public | BindingFlags.Instance;
            var nonPubInst = BindingFlags.NonPublic | BindingFlags.Instance;

            // Resource Cache
            if (_resCacheType != null)
                _resCacheGetMethod = _resCacheType.GetMethod("GetVesselCache", pub, null, new[] { typeof(Vessel) }, null);
            if (_vesselCacheType != null)
                _vesselCacheResourcesField = _vesselCacheType.GetField("resources", pubInst | nonPubInst);

            // Note: We use dynamic ReadMember for ResourceData fields (amount, capacity, rate)
            // because they switch between Field and Property in different versions.

            // DB methods
            if (_dbType != null)
            {
                _dbStormMethod = _dbType.GetMethod("Storm", pub, null, new[] { typeof(string) }, null);
                _dbKerbalMethod = _dbType.GetMethod("Kerbal", pub, null, new[] { typeof(string) }, null);
            }

            // StormData fields
            if (_stormDataType != null)
            {
                _stormStateField = _stormDataType.GetField("storm_state", pubInst | nonPubInst);
                _stormTimeField = _stormDataType.GetField("storm_time", pubInst | nonPubInst);
                _stormDurationField = _stormDataType.GetField("storm_duration", pubInst | nonPubInst);
            }

            // KerbalData
            if (_kerbalDataType != null)
                _kerbalRulesField = _kerbalDataType.GetField("rules", pubInst | nonPubInst);

            // VesselData extension lookup
            if (_vesselDataType != null)
            {
                foreach (var asm in AssemblyLoader.loadedAssemblies)
                {
                    try
                    {
                        foreach (var type in asm.assembly.GetTypes())
                        {
                            var m = type.GetMethod("KerbalismData", pub, null, new[] { typeof(Vessel) }, null);
                            if (m != null && m.ReturnType == _vesselDataType)
                            {
                                _kerbalismDataMethod = m;
                                break;
                            }
                        }
                        if (_kerbalismDataMethod != null) break;
                    }
                    catch { }
                }

                _vdEnvTemperature = _vesselDataType.GetProperty("EnvTemperature", pubInst);
                _vdEnvTempDiff = _vesselDataType.GetProperty("EnvTempDiff", pubInst);
                _vdEnvStormRadiation = _vesselDataType.GetProperty("EnvStormRadiation", pubInst);
                _vdEnvBreathable = _vesselDataType.GetProperty("EnvBreathable", pubInst);
                _vdEnvInAtmosphere = _vesselDataType.GetProperty("EnvInAtmosphere", pubInst);
                _vdCrewCount = _vesselDataType.GetProperty("CrewCount", pubInst);
                _vdCrewCapacity = _vesselDataType.GetProperty("CrewCapacity", pubInst);
                _vdMalfunction = _vesselDataType.GetProperty("Malfunction", pubInst);
                _vdCritical = _vesselDataType.GetProperty("Critical", pubInst);
                _vdSolarPanelExposure = _vesselDataType.GetProperty("SolarPanelsAverageExposure", pubInst);
                _vdDrivesFreeSpace = _vesselDataType.GetProperty("DrivesFreeSpace", pubInst);
                _vdDrivesCapacity = _vesselDataType.GetProperty("DrivesCapacity", pubInst);
                _vdConnection = _vesselDataType.GetProperty("Connection", pubInst);
            }
        }

        static object ReadMember(object obj, string name)
        {
            if (obj == null) return null;
            var type = obj.GetType();
            var bf = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.IgnoreCase;
            
            var prop = type.GetProperty(name, bf);
            if (prop != null) return prop.GetValue(obj, null);
            
            var field = type.GetField(name, bf);
            return field?.GetValue(obj);
        }

        static object CallAPI(string methodName)
        {
            if (_apiType == null) return null;
            if (!_apiMethods.TryGetValue(methodName, out var method))
            {
                method = _apiType.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static);
                _apiMethods[methodName] = method;
            }
            return method?.Invoke(null, null);
        }

        static object CallAPI(string methodName, Vessel v)
        {
            if (_apiType == null) return null;
            var key = methodName + "_v";
            if (!_apiMethods.TryGetValue(key, out var method))
            {
                method = _apiType.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(Vessel) }, null);
                _apiMethods[key] = method;
            }
            return method?.Invoke(null, new object[] { v });
        }

        static bool GetFeature(string name)
        {
            if (_featuresType == null) return false;
            var bf = BindingFlags.Public | BindingFlags.Static | BindingFlags.IgnoreCase;
            var prop = _featuresType.GetProperty(name, bf);
            if (prop != null) return (bool)prop.GetValue(null, null);
            var field = _featuresType.GetField(name, bf);
            return field != null && (bool)field.GetValue(null);
        }

        [TelemetryAPI("kerbalism.available", "Kerbalism Is Installed", AlwaysEvaluable = true, Category = "kerbalism", ReturnType = "bool", RequiresMod = "kerbalism")]
        object Available(DataSources ds) { Search(); return _apiType != null; }

        [TelemetryAPI("kerbalism.features", "Kerbalism Enabled Features", Category = "kerbalism", ReturnType = "object", RequiresMod = "kerbalism")]
        object Features(DataSources ds)
        {
            Search();
            if (_featuresType == null) return null;
            var result = new Dictionary<string, object>();
            foreach (var name in new[] { "Radiation", "Habitat", "Pressure", "Poisoning", "Science", "Reliability", "SpaceWeather" })
                result[name.ToLower()] = GetFeature(name);
            return result;
        }

        [TelemetryAPI("kerbalism.radiation", "Environment Radiation (rad/h)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object Radiation(DataSources ds) => CallAPI("Radiation", ds.vessel);

        [TelemetryAPI("kerbalism.habitatRadiation", "Habitat Radiation (rad/h)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object HabitatRadiation(DataSources ds) => CallAPI("HabitatRadiation", ds.vessel);

        [TelemetryAPI("kerbalism.co2Level", "CO2 Poisoning Level", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object CO2Level(DataSources ds) => CallAPI("Poisoning", ds.vessel);

        [TelemetryAPI("kerbalism.radiationShielding", "Radiation Shielding (0-1)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object RadiationShielding(DataSources ds) => CallAPI("Shielding", ds.vessel);

        [TelemetryAPI("kerbalism.habitatVolume", "Habitat Volume (m\u00b3)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object HabitatVolume(DataSources ds) => CallAPI("Volume", ds.vessel);

        [TelemetryAPI("kerbalism.habitatSurface", "Habitat Surface Area (m\u00b2)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object HabitatSurface(DataSources ds) => CallAPI("Surface", ds.vessel);

        [TelemetryAPI("kerbalism.habitatPressure", "Habitat Pressure (0-1)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object HabitatPressure(DataSources ds) => CallAPI("Pressure", ds.vessel);

        [TelemetryAPI("kerbalism.habitatLivingSpace", "Living Space Comfort Factor", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object HabitatLivingSpace(DataSources ds) => CallAPI("LivingSpace", ds.vessel);

        [TelemetryAPI("kerbalism.habitatComfort", "Overall Habitat Comfort Factor", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object HabitatComfort(DataSources ds) => CallAPI("Comfort", ds.vessel);

        [TelemetryAPI("kerbalism.connection", "Full Connection Info", Category = "kerbalism", ReturnType = "object", RequiresMod = "kerbalism")]
        object Connection(DataSources ds)
        {
            var vd = GetVesselData(ds.vessel);
            if (vd == null || _vdConnection == null) return null;
            var conn = _vdConnection.GetValue(vd);
            if (conn == null) return null;

            var info = new Dictionary<string, object>();
            info["linked"] = ReadMember(conn, "linked");
            info["rate"] = ReadMember(conn, "rate");
            info["strength"] = ReadMember(conn, "strength");
            info["status"] = ReadMember(conn, "status")?.ToString();
            info["target"] = ReadMember(conn, "target_name");
            info["ec"] = ReadMember(conn, "ec");
            info["ecIdle"] = ReadMember(conn, "ec_idle");
            return info;
        }

        // Flat connection helpers — required because JS subscribes to these keys directly
        [TelemetryAPI("kerbalism.connectionRate", "Connection TX Rate (MB/s)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object ConnectionRate(DataSources ds)
        {
            var vd = GetVesselData(ds.vessel);
            if (vd == null || _vdConnection == null) return null;
            var conn = _vdConnection.GetValue(vd);
            if (conn == null) return null;
            var rate = ReadMember(conn, "rate");
            return rate != null ? Convert.ToDouble(rate) : (object)null;
        }

        [TelemetryAPI("kerbalism.connectionLinked", "Connection Is Linked", Category = "kerbalism", ReturnType = "bool", RequiresMod = "kerbalism")]
        object ConnectionLinked(DataSources ds)
        {
            var vd = GetVesselData(ds.vessel);
            if (vd == null || _vdConnection == null) return null;
            var conn = _vdConnection.GetValue(vd);
            if (conn == null) return false;
            return ReadMember(conn, "linked");
        }

        [TelemetryAPI("kerbalism.drivesFreeSpace", "Drives Free Space (MB)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object DrivesFreeSpace(DataSources ds)
        {
            // Try VesselData property first, then fall back to API method
            var vd = GetVesselData(ds.vessel);
            if (vd != null && _vdDrivesFreeSpace != null)
            {
                try { return _vdDrivesFreeSpace.GetValue(vd); } catch { }
            }
            return CallAPI("DrivesFreeSpace", ds.vessel);
        }

        [TelemetryAPI("kerbalism.drivesCapacity", "Drives Total Capacity (MB)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object DrivesCapacity(DataSources ds)
        {
            var vd = GetVesselData(ds.vessel);
            if (vd != null && _vdDrivesCapacity != null)
            {
                try { return _vdDrivesCapacity.GetValue(vd); } catch { }
            }
            return CallAPI("DrivesCapacity", ds.vessel);
        }

        [TelemetryAPI("kerbalism.stellarStormState", "Stellar Storm State (0=clear 1=incoming 2=active)", Category = "kerbalism", ReturnType = "int", RequiresMod = "kerbalism")]
        object StellarStormState(DataSources ds)
        {
            var stormData = GetStormData(ds.vessel);
            if (stormData == null) return 0;
            var state = ReadMember(stormData, "storm_state");
            return state != null ? (int)Convert.ToUInt32(state) : 0;
        }

        [TelemetryAPI("kerbalism.crew", "Crew Health Summary", Category = "kerbalism", ReturnType = "object", RequiresMod = "kerbalism")]
        object CrewHealth(DataSources ds)
        {
            if (_dbKerbalMethod == null || _kerbalRulesField == null) return null;
            var crew = ds.vessel?.GetVesselCrew();
            if (crew == null) return null;

            var result = new List<Dictionary<string, object>>();
            foreach (var kerbal in crew)
            {
                var info = new Dictionary<string, object>();
                info["name"] = kerbal.name;
                info["trait"] = kerbal.experienceTrait?.Title;
                info["level"] = kerbal.experienceLevel;

                try
                {
                    var kd = _dbKerbalMethod.Invoke(null, new object[] { kerbal.name });
                    if (kd != null)
                    {
                        var rules = _kerbalRulesField.GetValue(kd) as IDictionary;
                        if (rules != null)
                        {
                            foreach (DictionaryEntry entry in rules)
                            {
                                var ruleName = entry.Key as string;
                                if (ruleName != null)
                                    info[ruleName.ToLower()] = ReadMember(entry.Value, "problem");
                            }
                        }
                    }
                }
                catch { }
                result.Add(info);
            }
            return result;
        }

        [TelemetryAPI("kerbalism.experimentRunning", "Experiment Is Running [string id]", Category = "kerbalism", ReturnType = "bool", RequiresMod = "kerbalism")]
        object ExperimentRunning(DataSources ds)
        {
            if (ds.args.Count < 1) return null;
            var key = "ExperimentIsRunning_vs";
            if (!_apiMethods.TryGetValue(key, out var method))
            {
                method = _apiType?.GetMethod("ExperimentIsRunning", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(Vessel), typeof(string) }, null);
                _apiMethods[key] = method;
            }
            return method?.Invoke(null, new object[] { ds.vessel, ds.args[0] });
        }

        [TelemetryAPI("kerbalism.science_progress", "Experiment Progress [string id]", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object ScienceProgress(DataSources ds) => CallAPI("ExperimentProgress", ds.vessel) ?? 0.0;

        [TelemetryAPI("kerbalism.res_rate", "Resource Net Rate (units/s) [string name]", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object ResourceRate(DataSources ds)
        {
            if (ds.args.Count < 1) return 0.0;
            var cache = GetVesselCache(ds.vessel);
            if (cache == null || _vesselCacheResourcesField == null) return 0.0;

            var resources = _vesselCacheResourcesField.GetValue(cache) as IDictionary;
            if (resources != null && resources.Contains(ds.args[0]))
            {
                var resData = resources[ds.args[0]];
                return Convert.ToDouble(ReadMember(resData, "rate") ?? 0.0);
            }
            return 0.0;
        }

        [TelemetryAPI("kerbalism.stellarStormIncoming", "Stellar Storm Incoming", Category = "kerbalism", ReturnType = "bool", RequiresMod = "kerbalism")]
        object SolarStormIncoming(DataSources ds)
        {
            var stormData = GetStormData(ds.vessel);
            if (stormData == null) return null;
            var state = ReadMember(stormData, "storm_state");
            return state != null && Convert.ToUInt32(state) == 1;
        }

        [TelemetryAPI("kerbalism.stellarStormInProgress", "Stellar Storm In Progress", Category = "kerbalism", ReturnType = "bool", RequiresMod = "kerbalism")]
        object SolarStormInProgress(DataSources ds)
        {
            var stormData = GetStormData(ds.vessel);
            if (stormData == null) return null;
            var state = ReadMember(stormData, "storm_state");
            return state != null && Convert.ToUInt32(state) == 2;
        }

        [TelemetryAPI("kerbalism.storm_countdown", "Time Until Solar Storm Impact (s)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object StormCountdown(DataSources ds)
        {
            var stormData = GetStormData(ds.vessel);
            if (stormData == null) return 0.0;
            var state = Convert.ToUInt32(ReadMember(stormData, "storm_state") ?? 0);
            if (state != 1) return 0.0;
            double startTime = Convert.ToDouble(ReadMember(stormData, "storm_time") ?? 0.0);
            return Math.Max(0, startTime - Planetarium.GetUniversalTime());
        }

        static object GetStormData(Vessel v)
        {
            if (_dbStormMethod == null || v?.mainBody == null) return null;
            try { return _dbStormMethod.Invoke(null, new object[] { v.mainBody.name }); }
            catch { return null; }
        }

        [TelemetryAPI("kerbalism.reliability", "Vessel Reliability Summary", Category = "kerbalism", ReturnType = "object", RequiresMod = "kerbalism")]
        object ReliabilitySummary(DataSources ds)
        {
            if (ds.vessel == null) return null;
            int malfunctions = 0;
            foreach (var part in ds.vessel.parts)
            {
                foreach (var module in part.Modules)
                {
                    var type = module.GetType();
                    if (type.Name.Contains("Reliability"))
                    {
                        // Kerbalism uses 'broken' in modern versions, 'malfunction' in legacy
                        var broken = ReadMember(module, "broken") ?? ReadMember(module, "malfunction");
                        if (broken is bool b && b) malfunctions++;
                    }
                }
            }
            var vd = GetVesselData(ds.vessel);
            bool critical = vd != null && (bool)(ReadMember(vd, "Critical") ?? false);
            return new Dictionary<string, object> { { "malfunctions", malfunctions }, { "critical", critical } };
        }

        [TelemetryAPI("kerbalism.envTemperature", "Environment Temperature (K)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object EnvTemperature(DataSources ds) => ReadMember(GetVesselData(ds.vessel), "EnvTemperature");

        [TelemetryAPI("kerbalism.breathable", "Atmosphere Breathable", Category = "kerbalism", ReturnType = "bool", RequiresMod = "kerbalism")]
        object Breathable(DataSources ds) => ReadMember(GetVesselData(ds.vessel), "EnvBreathable");

        [TelemetryAPI("kerbalism.solarExposure", "Solar Panel Average Exposure (0-1)", Category = "kerbalism", ReturnType = "double", RequiresMod = "kerbalism")]
        object SolarExposure(DataSources ds) => ReadMember(GetVesselData(ds.vessel), "SolarPanelsAverageExposure");

        [TelemetryAPI("kerbalism.engines", "Engine Reliability Summary", Category = "kerbalism", ReturnType = "object", RequiresMod = "kerbalism")]
        object EngineSummary(DataSources ds)
        {
            if (ds.vessel == null) return null;
            var engines = new List<Dictionary<string, object>>();
            foreach (var part in ds.vessel.parts)
            {
                foreach (var module in part.Modules)
                {
                    if (module is ModuleEngines engine)
                    {
                        var entry = new Dictionary<string, object>();
                        entry["part"] = part.partInfo.title;
                        entry["ignitions"] = ReadMember(module, "ignitions");
                        entry["burnTime"] = ReadMember(module, "burn_time");
                        entry["maxBurnTime"] = ReadMember(module, "rated_burn_time");
                        entry["isActive"] = engine.EngineIgnited;
                        entry["thrust"] = engine.finalThrust;
                        engines.Add(entry);
                    }
                }
            }
            return engines;
        }

        [TelemetryAPI("kerbalism.parts", "All Vessel Parts Health Status", Category = "kerbalism", ReturnType = "object", RequiresMod = "kerbalism")]
        object PartsHealth(DataSources ds)
        {
            if (ds.vessel == null) return null;
            var result = new List<Dictionary<string, object>>();

            foreach (var part in ds.vessel.parts)
            {
                var entry = new Dictionary<string, object>();
                entry["name"] = part.partInfo?.title ?? part.name;

                // Detect Kerbalism reliability malfunction: field is 'broken' in modern, 'malfunction' in legacy
                bool isMalfunctioned = false;
                bool hasReliability = false;
                foreach (var module in part.Modules)
                {
                    if (module.GetType().Name.Contains("Reliability"))
                    {
                        hasReliability = true;
                        var broken = ReadMember(module, "broken") ?? ReadMember(module, "malfunction");
                        if (broken is bool b && b) { isMalfunctioned = true; }
                    }
                }

                entry["malfunctioned"] = isMalfunctioned;
                entry["hasReliability"] = hasReliability;

                // Collect crew inside this part
                var crewInPart = part.protoModuleCrew;
                if (crewInPart != null && crewInPart.Count > 0)
                {
                    var crewNames = new List<string>();
                    foreach (var k in crewInPart) crewNames.Add(k.name);
                    entry["crew"] = crewNames;
                    entry["crewCount"] = crewNames.Count;
                }
                else
                {
                    entry["crew"] = new List<string>();
                    entry["crewCount"] = 0;
                }

                // Check if it has an engine module
                bool isEngine = false;
                foreach (var module in part.Modules)
                {
                    if (module is ModuleEngines eng)
                    {
                        isEngine = true;
                        entry["isEngine"] = true;
                        entry["isActive"] = eng.EngineIgnited;
                        entry["thrust"] = eng.finalThrust;
                        entry["ignitions"] = ReadMember(module, "ignitions");
                        break;
                    }
                }
                if (!isEngine) entry["isEngine"] = false;

                // Check if it has an antenna (ModuleDataTransmitter)
                bool isAntenna = false;
                foreach (var module in part.Modules)
                {
                    if (module is ModuleDataTransmitter antenna)
                    {
                        isAntenna = true;
                        entry["isAntenna"] = true;
                        entry["antennaPower"] = antenna.antennaPower;
                        entry["antennaType"] = antenna.antennaType.ToString();
                        entry["canTransmit"] = antenna.CanTransmit();

                        // Deployment state for deployable antennas
                        var deployMod = part.Modules.GetModule<ModuleDeployableAntenna>();
                        if (deployMod != null)
                        {
                            entry["deployState"] = deployMod.deployState.ToString();
                            entry["isDeployed"] = deployMod.deployState == ModuleDeployablePart.DeployState.EXTENDED;
                            entry["isBroken"] = deployMod.deployState == ModuleDeployablePart.DeployState.BROKEN;
                        }
                        else
                        {
                            entry["deployState"] = "FIXED";
                            entry["isDeployed"] = true;
                            entry["isBroken"] = false;
                        }
                        break;
                    }
                }
                if (!isAntenna) entry["isAntenna"] = false;

                // Check if it has a command module or probe core (ModuleCommand)
                bool isCommand = false;
                foreach (var module in part.Modules)
                {
                    if (module is ModuleCommand cmd)
                    {
                        isCommand = true;
                        entry["isCommand"] = true;
                        entry["minimumCrew"] = cmd.minimumCrew;
                        // vessel.IsControllable is the correct KSP API for checking full control authority
                        entry["hasControl"] = ds.vessel?.IsControllable ?? false;
                        entry["controlStatus"] = cmd.controlSrcStatusText ?? "";
                        break;
                    }
                }
                if (!isCommand) entry["isCommand"] = false;

                // Determine a human-readable part type label
                string partType = "PART";
                if (isCommand) partType = "COMMAND";
                if (isEngine) partType = "ENGINE";
                if (isAntenna) partType = "ANTENNA";
                if (hasReliability && !isEngine && !isAntenna && !isCommand) partType = "MODULE";
                entry["partType"] = partType;

                // Include: tracked by reliability, engine, antenna, command module, or crewed
                int crewCt = (int)(entry["crewCount"]);
                if (hasReliability || isEngine || isAntenna || isCommand || crewCt > 0)
                    result.Add(entry);
            }
            return result;
        }

        [TelemetryAPI("kerbalism.processes", "Active Process Status", Category = "kerbalism", ReturnType = "object", RequiresMod = "kerbalism")]
        object ProcessStatus(DataSources ds)
        {
            if (ds.vessel == null) return null;
            var processes = new List<Dictionary<string, object>>();
            foreach (var part in ds.vessel.parts)
            {
                foreach (var module in part.Modules)
                {
                    if (module.GetType().Name == "ProcessController")
                    {
                        var entry = new Dictionary<string, object>();
                        entry["name"] = ReadMember(module, "title")?.ToString() ?? "Unknown";
                        entry["running"] = ReadMember(module, "running") ?? false;
                        entry["part"] = part.partInfo.title;
                        processes.Add(entry);
                    }
                }
            }
            return processes;
        }

        static object GetVesselData(Vessel v)
        {
            if (_kerbalismDataMethod == null || v == null) return null;
            try { return _kerbalismDataMethod.Invoke(null, new object[] { v }); }
            catch { return null; }
        }

        static object GetVesselCache(Vessel v)
        {
            if (_resCacheGetMethod == null || v == null) return null;
            try { return _resCacheGetMethod.Invoke(null, new object[] { v }); }
            catch { return null; }
        }

        protected override int pausedHandler() => PausedDataLinkHandler.partPaused();
    }
}
