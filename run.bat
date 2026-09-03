@echo off
REM Launch the Show Creator and open it in your browser.
setlocal
cd /d "%~dp0"

set "PYCMD="
set "PYEXE="

REM 1) the py launcher, if it is on PATH
where py >nul 2>nul
if not errorlevel 1 set "PYCMD=py -3"
if defined PYCMD goto run

REM 2) python on PATH
where python >nul 2>nul
if not errorlevel 1 set "PYCMD=python"
if defined PYCMD goto run

REM 3) not on PATH - look in the usual install folders, newest first
call :try "%LOCALAPPDATA%\Programs\Python\Python313"
call :try "%LOCALAPPDATA%\Programs\Python\Python312"
call :try "%LOCALAPPDATA%\Programs\Python\Python311"
call :try "%LOCALAPPDATA%\Programs\Python\Python310"
call :try "%LOCALAPPDATA%\Programs\Python\Python39"
call :try "%LOCALAPPDATA%\Programs\Python\Python39-32"
call :try "%LOCALAPPDATA%\Programs\Python\Python38"
call :try "%ProgramFiles%\Python313"
call :try "%ProgramFiles%\Python312"
call :try "%ProgramFiles%\Python311"
call :try "%ProgramFiles%\Python310"
call :try "%ProgramFiles%\Python39"
call :try "%ProgramFiles%\Python38"
call :try "%ProgramFiles(x86)%\Python312-32"
call :try "%ProgramFiles(x86)%\Python39-32"
call :try "C:\Python313"
call :try "C:\Python312"
call :try "C:\Python311"
call :try "C:\Python310"
call :try "C:\Python39"
if defined PYEXE goto run

REM 4) last resort - scan for anything that looks like a Python 3 install
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do call :try "%%~fD"
if defined PYEXE goto run

echo.
echo Could not find Python 3 on this machine.
echo.
echo Install Python 3.8 or newer from https://www.python.org/downloads/
echo and tick "Add Python to PATH" in the installer, then run this again.
echo.
pause
goto end

:try
if defined PYEXE goto :eof
if exist "%~1\python.exe" set "PYEXE=%~1\python.exe"
goto :eof

:run
if defined PYCMD %PYCMD% server.py %*
if not defined PYCMD echo Using "%PYEXE%"
if not defined PYCMD "%PYEXE%" server.py %*
if errorlevel 1 pause
goto end

:end
endlocal
