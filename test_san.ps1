$sanOid = '2.5.29.17'
$sanText = '{text}DNS=localhost&DNS=myhostname&IPAddress=127.0.0.1&IPAddress=192.168.1.100'
$cert = New-SelfSignedCertificate -CertStoreLocation Cert:\CurrentUser\My -Subject 'CN=TestIP' -TextExtension @("$sanOid=$sanText")
$cert.Extensions | Where-Object {$_.Oid.Value -eq $sanOid} | ForEach-Object { $_.Format(0) }
$cert | Remove-Item
