using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

namespace Telemachus
{
    public class PlanetariumDataLinkHandler : DataLinkHandler
    {
        public PlanetariumDataLinkHandler(FormatterProvider formatters)
            : base(formatters) { }

        [TelemetryAPI("pl.meridianOffset", "Angle between World X and Inertial X (Equatorial)", Category = "system", ReturnType = "double", AlwaysEvaluable = true)]
        object MeridianOffset(DataSources ds)
        {
            // Planetarium.right is the direction of the inertial X axis in world coordinates.
            // This is the "Holy Grail" for orbital alignment.
            Vector3d inertialX = Planetarium.right;
            Vector3d worldX = Vector3d.right;
            Vector3d projInertialX = new Vector3d(inertialX.x, 0, inertialX.z).normalized;
            double angle = Vector3d.Angle(worldX, projInertialX);
            if (Vector3d.Cross(worldX, projInertialX).y < 0) angle = 360.0 - angle;
            return angle;
        }

        [TelemetryAPI("b.initialRotation", "Body Initial Rotation at UT=0", Category = "body", ReturnType = "double", Params = "int bodyId")]
        object InitialRotation(DataSources ds)
        {
            int id = int.Parse(ds.args[0]);
            if (id >= 0 && id < FlightGlobals.Bodies.Count) return FlightGlobals.Bodies[id].initialRotation;
            return 0.0;
        }

        // v21.8.66: Rotation components kept for compatibility but simplified.
        [TelemetryAPI("pl.rotationX", "Planetarium Rotation X", Category = "system", ReturnType = "double", AlwaysEvaluable = true)]
        object RotationX(DataSources ds) => 0.0;
        [TelemetryAPI("pl.rotationY", "Planetarium Rotation Y", Category = "system", ReturnType = "double", AlwaysEvaluable = true)]
        object RotationY(DataSources ds) => 0.0;
        [TelemetryAPI("pl.rotationZ", "Planetarium Rotation Z", Category = "system", ReturnType = "double", AlwaysEvaluable = true)]
        object RotationZ(DataSources ds) => 0.0;
    }
}
