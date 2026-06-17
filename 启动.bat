@echo off
chcp 65001 >nul
title 长安游伴 · 一键启动

echo ╔══════════════════════════════════════════════╗
echo ║     🏯 长安游伴 H5 一键启动                  ║
echo ║     服务器 + 内网穿透（自动启动）             ║
echo ╚══════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

echo [1/2] 检查 Node.js...
C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe --version 2>nul
if errorlevel 1 (
    echo ❌ Node.js 未找到，请检查安装
    pause
    exit /b 1
)

echo [2/2] 启动服务器（含自动内网穿透）...
echo.
echo ⏳ 服务器启动中，内网穿透约需 10-15 秒...
echo    启动完成后会显示公网地址，请稍等
echo.

start "长安游伴-服务器" cmd /k "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe proxy.js"

echo ⏳ 等待 15 秒后打开管理后台...
timeout /t 15 >nul

echo 打开本地管理后台...
start "" "http://localhost:3457/admin.html"

echo.
echo ✅ 启动完成！
echo.
echo 📍 本地地址（局域网内使用）：
echo    - 主页：http://localhost:3457/
echo    - 管理后台：http://localhost:3457/admin.html
echo.
echo 🌐 公网地址请查看「长安游伴-服务器」窗口
echo    出现"内网穿透成功"后，复制公网地址
echo.
echo 💡 下一步：
echo    1. 买家下单付款后
echo    2. 双击「生成买家访问码.bat」
echo    3. 链接自动复制，粘贴发给买家即可
echo.
pause
