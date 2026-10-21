from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import hashlib, shutil
root=Path.cwd()
out=root/'artifacts'
out.mkdir(exist_ok=True)
packages=[('my-video-app-extension.zip',root/'dist','my-video-app'),('my-video-app-source.zip',root,'my-video-app-source'),('my-video-app-antivirus-helper.zip',root/'native','my-video-app-antivirus-helper')]
for name,source,prefix in packages:
    with ZipFile(out/name,'w',compression=ZIP_DEFLATED,compresslevel=9) as z:
        for p in sorted(source.rglob('*')):
            rel=p.relative_to(source)
            if source==root and rel.parts[0] in {'.git','node_modules','dist','dist-compat','artifacts','test-results','.cache'}: continue
            if '__pycache__' in rel.parts or p.suffix in {'.log','.pyc','.eml','.pem','.key','.p12'}: continue
            if p.is_symlink(): raise ValueError('Symbolic links are not allowed in packages: '+str(rel))
            if not p.is_file(): continue
            if source==root/'native' and rel.name.startswith('test_'): continue
            info=ZipInfo(prefix+'/'+rel.as_posix(),date_time=(2026,10,18,0,0,0))
            info.compress_type=ZIP_DEFLATED
            info.external_attr=0o100644<<16
            z.writestr(info,p.read_bytes())
    print(name,(out/name).stat().st_size,'bytes')
aliases={'vdh-typescript-upscale-extension.zip':'my-video-app-extension.zip','vdh-typescript-upscale-source.zip':'my-video-app-source.zip'}
for alias,name in aliases.items():
    shutil.copyfile(out/name,out/alias)
lines=[]
for name in [p[0] for p in packages]+list(aliases):
    p=out/name
    lines.append(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+name)
(out/'SHA256SUMS').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines))
