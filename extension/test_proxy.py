import requests
import json

# Your proxy configuration
PROXY_URL = "https://totobox.vercel.app/api/proxy"
PROXY_KEY = "totobox_c6ypcnaj5fj6nvpweagc"

# Test with OpenAI-style API call
response = requests.post(
    PROXY_URL,
    headers={
        "Authorization": f"Bearer {PROXY_KEY}",
        "Content-Type": "application/json"
    },
    json={
        "model": "gpt-3.5-turbo",
        "messages": [
            {"role": "user", "content": "Say 'Hello from totoboX proxy!' in a fun way"}
        ]
    }
)

print("Status Code:", response.status_code)
print("\nResponse:")
print(json.dumps(response.json(), indent=2))

if response.status_code == 200:
    print("\n✅ SUCCESS! Proxy is working!")
    print("\nAI Response:", response.json()['choices'][0]['message']['content'])
else:
    print("\n❌ Error:", response.json())