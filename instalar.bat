@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Criando ambiente virtual...
py -3 -m venv .venv
if errorlevel 1 goto erro

echo Instalando dependencias...
call .venv\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 goto erro
call .venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto erro

echo.
echo Instalacao concluida.
echo Agora copie .env.example para .env e preencha os valores.
pause
exit /b 0

:erro
echo.
echo A instalacao falhou. Confirme se o Python esta instalado e marcado no PATH.
pause
exit /b 1
