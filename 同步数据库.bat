@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ============================================
echo   长安游伴 · 数据库同步到 GitHub
echo ============================================
echo.

:: Step 1: 校验 JSON 格式
echo [1/3] 校验 JSON 数据文件...
for %%f in (data\attractions.json data\foods.json data\hotels.json data\experience.json) do (
    node -e "try{require('./%%f');console.log('  OK  %%f');}catch(e){console.log('  ERROR  %%f: '+e.message);process.exit(1)}"
    if errorlevel 1 (
        echo.
        echo 校验失败，请修复 JSON 格式后重试！
        pause
        exit /b 1
    )
)
echo.

:: Step 2: 提交变更
echo [2/3] 提交到 Git...
set "COMMIT_MSG=chore: 更新数据库 %date:~0,10% %time:~0,5%"
git add data/ index.html local-db.js proxy.js
git diff --cached --stat
echo.
set /p CONFIRM=确认提交以上变更？(Y/N): 
if /i not "%CONFIRM%"=="Y" (
    echo 已取消。
    pause
    exit /b 0
)
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
    echo 提交失败（可能没有变更），跳过。
)

:: Step 3: 推送到 GitHub
echo.
echo [3/3] 推送到 GitHub...
git push origin master
if errorlevel 1 (
    echo.
    echo 推送失败！可能是网络问题。
    echo 可以稍后手动执行：git push origin master
    pause
    exit /b 1
)
echo.
echo ============================================
echo   同步完成！
echo   线上地址：https://jark01.github.io/changan-youban/
echo ============================================
pause
