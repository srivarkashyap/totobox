# totobox_vyvlyj283qf_1759738577912

# from openai import OpenAI

# client = OpenAI(
#     api_key="totobox_vyvlyj283qf_1759738577912",  # proxy key
#     base_url="https://totobox.vercel.app/api/proxy"
# )

# response = client.chat.completions.create(
#     model="gpt-3.5-turbo",
#     messages=[{"role": "user", "content": "Say hello!"}]
# )

# print(response.choices[0].message.content)

from openai import OpenAI

client = OpenAI(
    api_key="totobox_xxxxx...",  # Your proxy key
    base_url="https://totobox.vercel.app/api/proxy"
)

response = client.chat.completions.create(
    model="gpt-3.5-turbo",
    messages=[{"role": "user", "content": "Say hello!"}]
)

print(response.choices[0].message.content)