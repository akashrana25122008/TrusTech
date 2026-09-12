import os
import sys

# Ensure repo root (parent of backend/) is on sys.path so
# `from backend.app...` imports work when running `pytest` from backend/.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
