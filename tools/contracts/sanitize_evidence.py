"""Remove legacy capture identifiers before publishing/regenerating the catalog.

Aliases are HMAC references with a random, non-persisted key. This command never
prints original values. It only touches this task's docs/api/evidence JSON files.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'docs/api/evidence/2026-10-30'
PRIVATE_KEY = re.compile(r'^(?:\d{12,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|_ti[a-z0-9_]+|csm\d+)$', re.I)
CONSTANTS = {'protocol','protocal','cpc','appid','language','amp-product-type',
             'amp-account-source','client-source','locale'}


def main():
    files={p:json.loads(p.read_text()) for p in DIRECTORY.glob('*.json') if p.name!='source-anchors.json'}
    names=set()
    def find(value):
        if isinstance(value,dict):
            for key,child in value.items():
                if PRIVATE_KEY.fullmatch(key):
                    names.add(key)
                find(child)
        elif isinstance(value,list):
            for child in value:
                find(child)
        elif isinstance(value,str) and value.startswith(('{','[')):
            try:
                find(json.loads(value))
            except ValueError:
                pass
    for data in files.values():
        find(data)
    salt=os.urandom(32)
    aliases={key:'dynamic_ref_'+hmac.new(salt,key.encode(),hashlib.sha256).hexdigest()[:12] for key in names}
    def replace(value,path='capture'):
        if isinstance(value,dict):
            result={aliases.get(k,k):replace(v,path+'.'+aliases.get(k,k)) for k,v in value.items()}
            # Some early captures kept numeric ids and telemetry extension values.
            for key,v in list(result.items()):
                if key.lower()=='id' and isinstance(v,(int,float)):
                    result[key]=f'{{{{{path}.{key}:number}}}}'
            if 'headExtension' in result:
                for i,ext in enumerate(result['headExtension']):
                    if ext.get('name') not in CONSTANTS:
                        v=ext.get('value')
                        if not (isinstance(v,str) and v.startswith('{{')):
                            ext['value']=f'{{{{body.head.extension[{i}].value:{"number" if isinstance(v,(int,float)) else "string"}}}}}'
            if isinstance(result.get('head'),dict):
                for i,ext in enumerate(result['head'].get('extension',[])):
                    if isinstance(ext,dict) and ext.get('name') not in CONSTANTS:
                        v=ext.get('value')
                        if not (isinstance(v,str) and v.startswith('{{')):
                            ext['value']=f'{{{{body.head.extension[{i}].value:{"number" if isinstance(v,(int,float)) else "string"}}}}}'
            return result
        if isinstance(value,list):
            return [replace(v,path+f'[{i}]') for i,v in enumerate(value)]
        if isinstance(value,str):
            for key,alias in aliases.items():
                value=value.replace(key,alias)
            if value.startswith(('{','[')):
                try:
                    return json.dumps(replace(json.loads(value),path+'.$json'),ensure_ascii=False,separators=(',',':'))
                except ValueError:
                    pass
        return value
    for file,data in files.items():
        file.write_text(json.dumps(replace(data),ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'evidenceFilesSanitized':len(files),'dynamicKeysAliased':len(aliases),'originalValuesPrinted':False}))


if __name__=='__main__':
    main()
