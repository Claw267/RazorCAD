"""Builds app/js/i18n/<lang>.js (the interface in other languages) from strings.txt, the English texts one per
line, and <lang>.txt, lines "N|translation" with N the line of strings.txt. Every line must be there once.

To translate a new text: add its English at the end of strings.txt and a line with that number to each language
file, then run  python tools/i18n/build_dicts.py"""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'app', 'js', 'i18n')
src = open(os.path.join(HERE, 'strings.txt'), encoding='utf-8').read().split('\n')
src = [s for s in src if s != '']
os.makedirs(OUT, exist_ok=True)
# long German compounds: soft hyphens where they may break (the toolbar buttons are narrow)
SOFT = {'de': {
    'Extrusionsschnitt': 'Extrusions­schnitt', 'Rotationsschnitt': 'Rotations­schnitt', 'Kurvengesteuertes': 'Kurven­gesteuertes',
    'Skizzengesteuertes': 'Skizzen­gesteuertes', 'Referenzgeometrie': 'Referenz­geometrie', 'Masseneigenschaften': 'Massen­eigenschaften',
    'Kollisionsprüfung': 'Kollisions­prüfung', 'Konfigurationen': 'Konfigura­tionen', 'Strukturbauteil': 'Struktur­bauteil',
    'Zuschnittsliste': 'Zuschnitts­liste', 'Umformwerkzeuge': 'Umform­werkzeuge', 'Explosionsansicht': 'Explosions­ansicht',
    'Bewegungsstudie': 'Bewegungs­studie', 'Stücklistentabelle': 'Stücklisten­tabelle', 'Bohrungsbeschriftung': 'Bohrungs­beschriftung',
    'Mittelpunktmarkierung': 'Mittelpunkt­markierung', 'Oberflächenbeschaffenheit': 'Oberflächen­beschaffenheit', 'Änderungstabelle': 'Änderungs­tabelle',
    'Zuschnittslistentabelle': 'Zuschnittslisten­tabelle', 'Mittelpunktrechteck': 'Mittelpunkt­rechteck', 'Mittelpunktbogen': 'Mittelpunkt­bogen',
    'Skizzenverrundung': 'Skizzen­verrundung', 'Konstruktionsgeometrie': 'Konstruktions­geometrie', 'Tragflächenprofil': 'Tragflächen­profil',
    'Begrenzungsfläche': 'Begrenzungs­fläche', 'Gehrungslasche': 'Gehrungs­lasche', 'Bezugselement': 'Bezugs­element',
    'Schweißsymbol': 'Schweiß­symbol', 'Positionsnummer': 'Positions­nummer', 'Schnittansicht': 'Schnitt­ansicht',
    'Zeichnungsansicht': 'Zeichnungs­ansicht', 'Standardansichten': 'Standard­ansichten', 'Ansichtseigenschaften': 'Ansichts­eigenschaften',
    'Blatteigenschaften': 'Blatt­eigenschaften', 'Komponenten': 'Kompo­nenten', 'Kreismuster': 'Kreis­muster', 'Füllmuster': 'Füll­muster',
    'Kantenlasche': 'Kanten­lasche', 'Basislasche': 'Basis­lasche', 'Eckfreistich': 'Eck­freistich', 'Formschräge': 'Form­schräge',
    'Kosmetisches': 'Kosme­tisches', 'Koordinatenmaß': 'Koordinaten­maß', 'Fasenbemaßung': 'Fasen­bemaßung', 'Tangentenbogen': 'Tangenten­bogen',
    'Zusammenfügen': 'Zusammen­fügen', 'Kontrollkästchen': 'Kontroll­kästchen', 'Normteile': 'Norm­teile', 'Stückliste': 'Stück­liste',
}}
def soften(lang, text):
    for w, h in SOFT.get(lang, {}).items():
        text = text.replace(w, h)
    return text
for lang in ['de', 'fr', 'es']:
    rows = {}
    for line in open(os.path.join(HERE, lang + '.txt'), encoding='utf-8').read().split('\n'):
        if not line.strip():
            continue
        n, _, text = line.partition('|')
        n = int(n)
        assert n not in rows, (lang, 'twice', n)
        rows[n] = text.strip()
    missing = [i for i in range(1, len(src) + 1) if i not in rows]
    extra = [i for i in rows if i > len(src)]
    assert not missing and not extra, (lang, missing[:10], extra[:10])
    d = {src[i - 1]: soften(lang, rows[i]) for i in range(1, len(src) + 1) if rows[i] and rows[i] != src[i - 1]}
    body = ',\n'.join(f'  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}' for k, v in d.items())
    open(os.path.join(OUT, lang + '.js'), 'w', encoding='utf-8', newline='\n').write(
        f'// RazorCAD interface texts in {lang} (English → {lang}); built from tools/i18n/{lang}.txt\n'
        f'export default {{\n{body},\n}};\n')
    print(lang, len(d), 'texts')
