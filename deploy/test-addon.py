import sys
sys.path.insert(0, '/app')
try:
    from proxy.addons.location_spoof import addons
    print("OK: Addon loaded successfully")
    print(f"Addons: {addons}")
except Exception as e:
    print(f"FAIL: {e}")
    import traceback
    traceback.print_exc()
