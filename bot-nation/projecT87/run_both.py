import threading
import subprocess
import time
import sys
import os
import atexit
import signal

LOCK_FILE = '/tmp/run_both.lock'

def cleanup_lock():
    try:
        if os.path.exists(LOCK_FILE):
            with open(LOCK_FILE, 'r') as f:
                pid = int(f.read().strip())
            if pid == os.getpid():
                os.remove(LOCK_FILE)
    except (OSError, ValueError):
        pass

def signal_handler(signum, frame):
    cleanup_lock()
    sys.exit(0)

def run_agent():
    """Run the autonomous agent in a loop to handle crashes/restarts"""
    while True:
        try:
            print("🚀 Starting Autonomous Agent...", flush=True)
            subprocess.run([sys.executable, "run_autonomous_mainnet.py"])
            print("⚠️ Agent stopped. Restarting in 5 seconds...", flush=True)
            time.sleep(5)
        except Exception as e:
            print(f"❌ Agent execution error: {e}. Restarting...", flush=True)
            time.sleep(5)

def run_api_server():
    """Run the FastAPI/Uvicorn API server (serves both API + Flask dashboard)"""
    while True:
        try:
            print("🚀 Starting OpenClaw API Server (FastAPI + Flask Dashboard)...", flush=True)
            subprocess.run([sys.executable, "api_server.py"])
            print("⚠️ API Server stopped. Restarting in 5 seconds...", flush=True)
            time.sleep(5)
        except Exception as e:
            print(f"❌ API Server execution error: {e}. Restarting...", flush=True)
            time.sleep(5)

if __name__ == "__main__":
    os.environ['LAUNCHED_BY_RUN_BOTH'] = '1'
    with open(LOCK_FILE, 'w') as f:
        f.write(str(os.getpid()))
    atexit.register(cleanup_lock)
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    print("🤖 SYSTEM LAUNCH: Dual-Process Mode", flush=True)

    agent_thread = threading.Thread(target=run_agent, daemon=True)
    agent_thread.start()

    run_api_server()
