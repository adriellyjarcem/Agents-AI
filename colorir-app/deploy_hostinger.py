"""Envia colorir-app/web para public_html/<pasta> na Hostinger (API + upload tus).
Uso: python3 deploy_hostinger.py <usuario> <dominio> <pasta-remota> <dir-local>
O token da API é injetado pelo proxy da sessão; nada é gravado em disco além de um arquivo
temporário de cabeçalhos, apagado ao final."""
import json, os, subprocess, sys, tempfile, urllib.parse
user, domain, remote, local = sys.argv[1:5]
API = 'https://developers.hostinger.com/api/hosting/v1'
def curl(*a, data=None):
    r = subprocess.run(['curl', '-sS', '-m', '180', '-w', '\n%{http_code}', *a], input=data, capture_output=True)
    body, _, code = r.stdout.rpartition(b'\n')
    return int(code or 0), body, r.stderr.decode()
code, body, err = curl('-X', 'POST', '-H', 'Content-Type: application/json', '-d', json.dumps({'username': user, 'domain': domain}), API + '/files/upload-urls')
assert code == 200, (code, body[:300], err)
c = json.loads(body); base = c['url'].rstrip('/')
hf = tempfile.NamedTemporaryFile('w', suffix='.hdr', delete=False)
hf.write('X-Auth: %s\nX-Auth-Rest: %s\n' % (c['auth_key'], c['rest_auth_key'])); hf.close()
ok = fail = 0
try:
    files = []
    for root, _, names in os.walk(local):
        for n in names: files.append(os.path.join(root, n))
    for f in sorted(files):
        rel = remote.strip('/') + '/' + os.path.relpath(f, local).replace(os.sep, '/')
        url = base + '/' + '/'.join(urllib.parse.quote(s, safe='') for s in rel.split('/')) + '?override=true'
        size = os.path.getsize(f)
        code, body, err = curl('-X', 'POST', '-H', '@' + hf.name, '-H', 'upload-length: %d' % size, '-H', 'upload-offset: 0', '-H', 'Content-Length: 0', url)
        if code != 201:
            print('FALHOU criar', rel, code, body[:200], err[:200]); fail += 1; continue
        code, body, err = curl('-X', 'PATCH', '-H', '@' + hf.name, '-H', 'Tus-Resumable: 1.0.0', '-H', 'Upload-Offset: 0',
                               '-H', 'Content-Type: application/offset+octet-stream', '--data-binary', '@' + f, url)
        if code in (200, 204): ok += 1; print('ok', rel, size)
        else: print('FALHOU enviar', rel, code, body[:200], err[:200]); fail += 1
finally:
    os.unlink(hf.name)
print('enviados', ok, 'falhas', fail)
sys.exit(1 if fail else 0)
