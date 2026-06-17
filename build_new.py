#!/usr/bin/env python3
"""Build new 圆周旅迹 style index.html by merging new CSS + HTML with old JS"""

import re

# Read existing file
with open('C:/Users/Administrator/Desktop/xiaoba-h5/index.html', 'r', encoding='utf-8') as f:
    old = f.read()

# Extract <script> block
script_start = old.index('<script>')
script_code = old[script_start:]

# Extract modals HTML (from FORM page onwards)
style_end = old.index('</style>') + len('</style>')
modals_html = old[style_end:script_start]

# Find form page
form_start = modals_html.find('<!-- ===== FORM =====')
remaining = modals_html[form_start:] if form_start > 0 else ''

# Now build new CSS
css_path = 'C:/Users/Administrator/Desktop/xiaoba-h5/new_css.txt'
html_body_path = 'C:/Users/Administrator/Desktop/xiaoba-h5/new_body.txt'

with open(css_path, 'r', encoding='utf-8') as f:
    css = f.read()

with open(html_body_path, 'r', encoding='utf-8') as f:
    html_body = f.read()

# Assemble complete file
html = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>长安游伴 · 西安AI旅行规划师</title>
  <style>
''' + css + html_body + remaining + '\n' + script_code

with open('C:/Users/Administrator/Desktop/xiaoba-h5/index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print('Done! File size:', len(html), 'chars')
print('CSS size:', len(css), 'chars')
print('HTML body size:', len(html_body), 'chars')
print('Remaining modals size:', len(remaining), 'chars')
print('JS size:', len(script_code), 'chars')
