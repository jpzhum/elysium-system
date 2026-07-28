@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Ambiente virtual nao encontrado. Execute instalar.bat primeiro.
    pause
    exit /b 1
)

if not exist ".env" (
    echo Arquivo .env nao encontrado.
    echo Copie .env.example, renomeie para .env e preencha os valores.
    pause
    exit /b 1
)

call .venv\Scripts\python.exe bot.py

echo.
echo O bot foi encerrado. Leia as mensagens acima para identificar possiveis erros.
pause
