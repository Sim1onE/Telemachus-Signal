using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using KSP.UI.Screens;

namespace Telemachus
{
    /// <summary>
    /// Exposes science experiment data, career mode currencies (funds/reputation),
    /// and CommNet connectivity status. All from stock KSP APIs.
    /// </summary>
    public class ScienceCareerDataLinkHandler : DataLinkHandler
    {
        public ScienceCareerDataLinkHandler(FormatterProvider formatters)
            : base(formatters) { }

        // --- Science ---

        [TelemetryAPI("sci.count", "Number of Science Experiments Aboard", Category = "science", ReturnType = "int")]
        object ScienceCount(DataSources ds)
        {
            int count = 0;
            foreach (var part in ds.vessel.parts)
            {
                foreach (var module in part.Modules)
                {
                    if (module is ModuleScienceExperiment)
                        count++;
                    if (module is ModuleScienceContainer container)
                        count += container.GetScienceCount();
                }
            }
            return count;
        }

        [TelemetryAPI("sci.dataAmount", "Total Science Data Aboard", Category = "science", ReturnType = "double")]
        object ScienceDataAmount(DataSources ds)
        {
            double total = 0;
            foreach (var part in ds.vessel.parts)
            {
                foreach (var module in part.Modules)
                {
                    if (module is IScienceDataContainer container)
                    {
                        var data = container.GetData();
                        if (data != null)
                        {
                            foreach (var d in data)
                                total += d.dataAmount;
                        }
                    }
                }
            }
            return total;
        }

        [TelemetryAPI("sci.experiments", "Experiments With Data", Plotable = false, Category = "science", ReturnType = "object")]
        object ScienceExperiments(DataSources ds)
        {
            var result = new List<Dictionary<string, object>>();
            foreach (var part in ds.vessel.parts)
            {
                foreach (var module in part.Modules)
                {
                    if (module is IScienceDataContainer container)
                    {
                        var data = container.GetData();
                        if (data == null || data.Length == 0) continue;

                        foreach (var d in data)
                        {
                            result.Add(new Dictionary<string, object>
                            {
                                ["part"] = part.partInfo.title,
                                ["title"] = d.title,
                                ["dataAmount"] = d.dataAmount,
                                ["scienceValueBase"] = d.baseTransmitValue,
                                ["transmitBoost"] = d.transmitBonus,
                                ["subjectId"] = d.subjectID
                            });
                        }
                    }
                }
            }
            return result;
        }

        // --- Career ---

        [TelemetryAPI("career.funds", "Available Funds", AlwaysEvaluable = true, Category = "career", ReturnType = "double")]
        object Funds(DataSources ds) =>
            Funding.Instance != null ? Funding.Instance.Funds : 0d;

        [TelemetryAPI("career.reputation", "Current Reputation", AlwaysEvaluable = true, Category = "career", ReturnType = "double")]
        object Rep(DataSources ds) => Reputation.CurrentRep;

        [TelemetryAPI("career.science", "Available Science Points", AlwaysEvaluable = true, Category = "career", ReturnType = "double")]
        object SciencePoints(DataSources ds) =>
            ResearchAndDevelopment.Instance != null ? ResearchAndDevelopment.Instance.Science : 0f;

        [TelemetryAPI("career.mode", "Game Mode (CAREER/SCIENCE/SANDBOX)", Units = APIEntry.UnitType.STRING, AlwaysEvaluable = true, Category = "career", ReturnType = "string")]
        object GameMode(DataSources ds) => HighLogic.CurrentGame?.Mode.ToString() ?? "";

        // --- CommNet ---

        [TelemetryAPI("comm.connected", "CommNet Is Connected", Category = "comms", ReturnType = "bool")]
        object CommConnected(DataSources ds) =>
            Telemachus.TelemachusSignalManager.GetSignalQuality(ds.vessel) > 0.001;

        [TelemetryAPI("comm.signalStrength", "CommNet Signal Strength (0-1)", Category = "comms", ReturnType = "double")]
        object CommSignalStrength(DataSources ds) {
            if (Telemachus.CameraSnapshots.CameraCapture.DebugSignalOverride >= 0f)
                return (double)Telemachus.CameraSnapshots.CameraCapture.DebugSignalOverride;
            return Telemachus.TelemachusSignalManager.GetSignalQuality(ds.vessel);
        }

        [TelemetryAPI("comm.controlState", "CommNet Control State (0=none, 1=partial, 2=full)", Category = "comms", ReturnType = "int")]
        object CommControlState(DataSources ds)
        {
            if (ds.vessel.Connection == null) return 0;
            // Kerbalism affects connectivity, but Stock control state is still a good fallback
            // for knowing if the vessel HAS command capability.
            string state = ds.vessel.Connection.ControlState.ToString();
            if (state.Contains("Full") || state == "Probe") return 2;
            if (state.Contains("Partial")) return 1;
            return 0;
        }

        [TelemetryAPI("comm.controlStateName", "CommNet Control State Name", Units = APIEntry.UnitType.STRING, Category = "comms", ReturnType = "string")]
        object CommControlStateName(DataSources ds) =>
            ds.vessel.Connection?.ControlState.ToString() ?? "None";

        [TelemetryAPI("comm.signalDelay", "CommNet Signal Delay (seconds)", Units = APIEntry.UnitType.TIME, Category = "comms", ReturnType = "double")]
        object CommSignalDelay(DataSources ds) {
            if (Telemachus.CameraSnapshots.CameraCapture.DebugDelayOverride >= 0f)
                return (double)Telemachus.CameraSnapshots.CameraCapture.DebugDelayOverride;
            
            return Telemachus.TelemachusSignalManager.GetSignalDelay(ds.vessel);
        }

        [TelemetryAPI("sci.parts", "List of Science Parts Aboard (VAB Category Scan)", Plotable = false, Category = "science", ReturnType = "object")]
        object ScienceParts(DataSources ds)
        {
            var partsList = new List<Dictionary<string, object>>();
            if (ds.vessel == null) return new Dictionary<string, object> { ["parts"] = partsList, ["hasKerbalism"] = false };

            // Check if Kerbalism is installed
            bool hasKerbalism = AssemblyLoader.loadedAssemblies.Cast<AssemblyLoader.LoadedAssembly>().Any(a => a.assembly.GetName().Name == "Kerbalism");

            foreach (var part in ds.vessel.parts)
            {
                bool isScienceCategory = part.partInfo.category == PartCategories.Science;
                bool hasScienceInterface = part.FindModulesImplementing<IScienceDataContainer>().Count > 0;
                
                bool hasScienceKeywords = false;
                if (!isScienceCategory && !hasScienceInterface)
                {
                    foreach(var m in part.Modules)
                    {
                        string lowName = m.moduleName.ToLower();
                        if (lowName.Contains("experiment") || lowName.Contains("science") || lowName.Contains("lab"))
                        {
                            hasScienceKeywords = true;
                            break;
                        }
                    }
                }

                if (isScienceCategory || hasScienceInterface || hasScienceKeywords)
                {
                    var info = new Dictionary<string, object>
                    {
                        ["id"] = (uint)part.persistentId,
                        ["title"] = part.partInfo.title,
                        ["isRunning"] = false,
                        ["hasData"] = false,
                        ["canRun"] = false
                    };

                    foreach (var module in part.Modules)
                    {
                        if (module is ModuleScienceExperiment exp)
                        {
                            if (exp.GetData()?.Length > 0) info["hasData"] = true;
                            info["canRun"] = true;
                            if (exp.Deployed) info["isRunning"] = true;
                        }
                        else if (module is ModuleScienceContainer container)
                        {
                            if (container.GetScienceCount() > 0) info["hasData"] = true;
                        }
                        else if (module is IScienceDataContainer genericContainer)
                        {
                            if (genericContainer.GetData()?.Length > 0) info["hasData"] = true;
                        }

                        if (IsModuleActive(module)) info["isRunning"] = true;
                    }

                    partsList.Add(info);
                }
            }
            return new Dictionary<string, object> 
            { 
                ["parts"] = partsList, 
                ["hasKerbalism"] = hasKerbalism 
            };
        }

        [TelemetryAPI("f.sci.run", "Trigger a science log", IsAction = true, Category = "science", ReturnType = "int", Params = "uint partId")]
        object RunExperiment(DataSources ds)
        {
            if (ds.vessel == null) return 0;
            uint id = uint.Parse(ds.args[0]);
            var part = ds.vessel.parts.Find(p => p.persistentId == id);
            if (part == null) return 0;

            foreach (var exp in part.FindModulesImplementing<ModuleScienceExperiment>())
            {
                exp.DeployExperiment();
            }
            return 1;
        }

        private static bool IsModuleActive(PartModule module)
        {
            string[] probeNames = { "running", "Deployed", "active", "enabled", "isEnabled" };
            foreach (var name in probeNames)
            {
                object val = ReadMember(module, name);
                if (val is bool b && b) return true;
                if (val is int i && i > 0) return true;
            }
            return false;
        }

        private static object ReadMember(object obj, string memberName)
        {
            try
            {
                var type = obj.GetType();
                var field = type.GetField(memberName, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                if (field != null) return field.GetValue(obj);

                var prop = type.GetProperty(memberName, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
                if (prop != null) return prop.GetValue(obj, null);
            }
            catch { }
            return null;
        }

        protected override int pausedHandler() => 0;
    }
}
