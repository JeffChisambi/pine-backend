# Pine Backend — ngrok tunnel starter
# Usage: .\start-tunnel.ps1
#
# This script:
#   1. Starts ngrok on port 3000
#   2. Fetches the public URL from ngrok's API
#   3. Updates .env with the NGROK_URL
#   4. Prints the URL for use in EXPO_PUBLIC_API_URL

Write-Host "Starting ngrok tunnel on port 3000..." -ForegroundColor Cyan

# Start ngrok in the background
Start-Process -NoNewWindow -FilePath "ngrok" -ArgumentList "http 3000" -PassThru | Out-Null

# Wait for ngrok to start
Start-Sleep -Seconds 3

# Get the public URL from ngrok's local API
try {
    $response = Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" -ErrorAction Stop
    $publicUrl = ($response.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1).public_url

    if ($publicUrl) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "  ngrok tunnel active!" -ForegroundColor Green
        Write-Host "  Public URL: $publicUrl" -ForegroundColor Yellow
        Write-Host "========================================" -ForegroundColor Green
        Write-Host ""

        # Update .env NGROK_URL
        $envPath = Join-Path $PSScriptRoot ".env"
        $envContent = Get-Content $envPath -Raw
        $envContent = $envContent -replace "NGROK_URL=.*", "NGROK_URL=$publicUrl"
        Set-Content $envPath $envContent -NoNewline
        Write-Host "Updated .env with NGROK_URL=$publicUrl" -ForegroundColor Cyan

        Write-Host ""
        Write-Host "For testers, set this in the mobile app build:" -ForegroundColor White
        Write-Host "  EXPO_PUBLIC_API_URL=$publicUrl/v1" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Or add to Pine/.env:" -ForegroundColor White
        Write-Host "  EXPO_PUBLIC_API_URL=$publicUrl/v1" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Then restart the backend: npm run start:dev" -ForegroundColor Cyan
    } else {
        Write-Host "Could not find HTTPS tunnel URL" -ForegroundColor Red
    }
} catch {
    Write-Host "Failed to connect to ngrok API. Is ngrok running?" -ForegroundColor Red
    Write-Host "Try running: ngrok http 3000" -ForegroundColor Yellow
}
