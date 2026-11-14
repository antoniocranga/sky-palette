#!/usr/bin/env python3
import sys
import json

env_target = sys.argv[1] if len(sys.argv) > 1 else 'staging'

if env_target == 'production':
    script_name = 'sky-palette'
    db_id = '5e1c6b54-4020-4e9b-a5d5-0cea27498741'
    app_url = 'https://skypalette.app'
else:
    script_name = 'sky-palette-staging'
    db_id = '20ab2ccb-37c3-4742-bab0-faf791c26b28'
    app_url = 'https://staging.skypalette.app'

with open('dist/worker.js', 'r', encoding='utf-8') as f:
    worker_code = f.read()

code_json = json.dumps(worker_code)

js_snippet = f"""async () => {{
  const code = {code_json};
  const metadata = {{
    main_module: "worker.js",
    bindings: [
      {{
        type: "d1",
        name: "DB",
        id: "{db_id}"
      }},
      {{
        type: "plain_text",
        name: "ENVIRONMENT",
        text: "{env_target}"
      }},
      {{
        type: "plain_text",
        name: "APP_URL",
        text: "{app_url}"
      }}
    ],
    compatibility_date: "2024-11-12",
    compatibility_flags: ["nodejs_compat"]
  }};

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], {{ type: "application/json" }}));
  form.append("worker.js", new Blob([code], {{ type: "application/javascript+module" }}), "worker.js");

  return cloudflare.request({{
    method: "PUT",
    path: "/accounts/" + accountId + "/workers/scripts/{script_name}",
    body: form
  }});
}}"""

filename = f'scripts/deploy_{env_target}.js'
with open(filename, 'w', encoding='utf-8') as f:
    f.write(js_snippet)

print(f"Generated {filename} for {env_target} ({script_name}, {len(js_snippet)} bytes)")
