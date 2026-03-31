import os
import re

def sanitize_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Change 1: HTTP links to CDNs -> Protocol-agnostic
    content = content.replace('http://code.jquery.com', '//code.jquery.com')
    content = content.replace('http://www.w3.org/2000/svg', 'http://www.w3.org/2000/svg') # Keep XMLNS as is
    
    # Change 2: Handle cases where 'http://' is hardcoded for resources
    # Use re to match http://localhost:8085 and replace with relative paths or dynamic ones
    content = content.replace('http://localhost:8085/telemachus/', '/telemachus/')
    
    # Change 3: Specific for leaflet if it forces http
    content = content.replace('http://{s}.tile.osm.org', '//{s}.tile.osm.org')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

def walk_and_sanitize(directory):
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.endswith(('.html', '.js', '.css', '.xml')):
                sanitize_file(os.path.join(root, file))

if __name__ == "__main__":
    target_dir = os.path.dirname(os.path.abspath(__file__))
    print(f"Sanitizing assets in: {target_dir}")
    walk_and_sanitize(target_dir)
    print("Optimization complete.")
