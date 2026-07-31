import json
import decimal
import time
from datetime import datetime

class DecimalEncoder(json.JSONEncoder):
    """Custom JSON encoder that handles Decimal objects"""
    def default(self, obj):
        if isinstance(obj, decimal.Decimal):
            return float(obj)
        elif isinstance(obj, datetime):
            return obj.isoformat()
        elif hasattr(obj, '__dict__'):
            return obj.__dict__
        return super(DecimalEncoder, self).default(obj)

def safe_json_dump(data, filename):
    """Safely dump JSON data with Decimal handling"""
    try:
        with open(filename, 'w') as f:
            json.dump(data, f, cls=DecimalEncoder, indent=2, default=str)
        return True
    except Exception as e:
        print(f"❌ JSON dump failed: {e}")
        return False

def safe_json_dumps(data):
    """Safely convert data to JSON string with Decimal handling"""
    try:
        return json.dumps(data, cls=DecimalEncoder, indent=2, default=str)
    except Exception as e:
        print(f"❌ JSON dumps failed: {e}")
        return "{}"

# Test the encoder
if __name__ == "__main__":
    test_data = {
        'decimal_value': decimal.Decimal('123.456'),
        'float_value': 789.012,
        'timestamp': datetime.now(),
        'string_value': 'test'
    }

    result = safe_json_dumps(test_data)
    print("✅ JSON serialization test passed")
    print(result)