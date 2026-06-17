@echo off
chcp 65001 >nul
title 长安游伴 · 生成买家访问码

echo ╔══════════════════════════════════════════╗
echo ║     🎫 一键生成买家访问码                ║
echo ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: 读取公网地址（先读项目目录，再读临时目录）
set PUBLIC_URL=
if exist "tunnel-url.txt" (
    set /p PUBLIC_URL=<tunnel-url.txt
)
if "%PUBLIC_URL%"=="" (
    if exist "%TEMP%\changan-tunnel-url.txt" (
        set /p PUBLIC_URL=<%TEMP%\changan-tunnel-url.txt
    )
)
if "%PUBLIC_URL%"=="" (
    echo ⚠️  未找到公网地址，请先运行「启动.bat」开启内网穿透
    echo    使用本地地址代替：http://localhost:3457
    set PUBLIC_URL=http://localhost:3457
) else (
    echo ✅ 公网地址：%PUBLIC_URL%
)

echo.
echo 📡 正在生成访问码...

:: 调用 API 生成 token
for /f "delims=" %%i in ('C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe -e "const http=require('http');const data=JSON.stringify({key:'changan2026',count:1});const req=http.request({hostname:'localhost',port:3457,path:'/api/token?action=create',method:'POST',headers:{'Content-Type':'application/json','Content-Length':data.length}},(res)=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{const r=JSON.parse(b);console.log(r.token||(r.tokens&&r.tokens[0])||'ERROR');}catch(e){console.log('ERROR');}process.exit(0);});});req.on('error',()=>{console.log('CONNECTION_ERROR');process.exit(1);});req.write(data);req.end();" 2^>nul') do set TOKEN=%%i

if "%TOKEN%"=="CONNECTION_ERROR" (
    echo ❌ 无法连接服务器！请先双击「启动.bat」启动服务
    pause
    exit /b 1
)

if "%TOKEN%"=="ERROR" (
    echo ❌ 生成失败，请检查配置
    pause
    exit /b 1
)

set LINK=%PUBLIC_URL%/index.html?token=%TOKEN%

echo.
echo ════════════════════════════════════════════════════════════════
echo  🎫 访问码：%TOKEN%
echo.
echo  🔗 买家专属链接（复制发给对方）：
echo  %LINK%
echo ════════════════════════════════════════════════════════════════
echo.
echo  ⚠️  注意：链接首次打开可能需要点击"Click to Continue"确认
echo  💡 使用完一次后自动失效，无法再次生成规划
echo.

:: 复制链接到剪贴板
echo %LINK% | clip
echo ✅ 链接已自动复制到剪贴板！直接粘贴到微信/闲鱼发给买家
echo.
pause
