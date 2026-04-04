using System;
using System.Collections.Generic;
using UnityEngine;

namespace Telemachus
{
    /// <summary>
    /// Simple utility to execute code from background threads (like WebSockets) on the Unity Main Thread.
    /// Used for spawning GameObjects or interacting with Unity's non-thread-safe API.
    /// </summary>
    public class MainThreadDispatcher : MonoBehaviour
    {
        private static readonly Queue<Action> _executionQueue = new Queue<Action>();
        private static MainThreadDispatcher _instance;
        private static int _mainThreadId;

        public void Awake()
        {
            _mainThreadId = System.Threading.Thread.CurrentThread.ManagedThreadId;
            _instance = this;
            DontDestroyOnLoad(gameObject);
        }

        public static void Ensure()
        {
            if (_instance != null) return;
            
            // Find existing or create new
            _instance = FindObjectOfType<MainThreadDispatcher>();
            if (_instance == null)
            {
                var go = new GameObject("TelemachusMainThreadDispatcher");
                _instance = go.AddComponent<MainThreadDispatcher>();
                DontDestroyOnLoad(go);
            }
        }

        public void Update()
        {
            lock (_executionQueue)
            {
                while (_executionQueue.Count > 0)
                {
                    try {
                        _executionQueue.Dequeue().Invoke();
                    } catch (Exception ex) {
                        PluginLogger.print("Error in MainThreadDispatcher: " + ex.ToString());
                    }
                }
            }
        }

        public static bool IsMainThread => System.Threading.Thread.CurrentThread.ManagedThreadId == _mainThreadId;

        public static void Enqueue(Action action)
        {
            if (IsMainThread)
            {
                action();
                return;
            }

            lock (_executionQueue)
            {
                _executionQueue.Enqueue(action);
            }
        }

        public static T Run<T>(Func<T> function)
        {
            if (IsMainThread)
            {
                return function();
            }

            T result = default;
            var evt = new System.Threading.ManualResetEvent(false);
            
            Enqueue(() =>
            {
                try {
                    result = function();
                } finally {
                    evt.Set();
                }
            });

            evt.WaitOne();
            return result;
        }
    }
}
