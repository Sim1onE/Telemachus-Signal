Get-ChildItem -Path Cert:\CurrentUser\Root | Where-Object { $_.Subject -match "Telemachus" } | Select-Object Subject, Thumbprint
