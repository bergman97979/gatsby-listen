"""Verify every in-text gloss and the recurring difficult vocabulary of this edition."""
import json
import re
from pathlib import Path

# Reviewed surface forms in the novel, including inflections and related forms.
# Keep each new occurrence paired with its own Chinese translation and definition.
DIFFICULT_FORMS = """
abortive abstractedly abstraction abyss addenda adventitious affront airedale amorphous amour
anaemic antecedents anteroom anticlimax apathetically apparition appendicitis aquaplanes armistice
ashen awnings banns bantering beaux begotten belasco benediction billow bleared boarder bona-fide
bonnet bootlegger bootleggers brace bracing broiling bulbous bureau cadet caravansary cataracts
caterer's caterers caterwauling ceaselessly ceremoniously chandelier chartreuse chiffon
circumstantial clamorously claret cobbled colossal commotion complacency complacent compulsion
conceits condescension conscientious conscientiously conservatory conspiring contempt contemptuous
contemptuously contingencies contingency contralto convivial cordial cordials corky cornices coroner
corpulent corroborate corroborated corrugated countenance counter-raid cowered crabbing credulity
crescendo crooned crêpe-de-chine cynical cynically day-coach debauchee defiance defiant defiantly
deft defunct dejection demoniac denizen deranged desolate despicable dilatory disarray disconcerting
discreet disembodied dishevelled dismayed disquieting dissension distraught divan divot dog-days
drawbridge duster début echolalia ecstasy ecstatic ecstatically ectoplasm effeminate ejaculated
elicited elocution eluded eludes eluding elusive enjoined epigram ether euphemisms evasions exalted
exhilarating expostulation extemporizing extravaganza exultation exulting fender fenders
finger-bowls flat-footed flinched florid fluctuate fluctuating flyleaf foghorn foliage formidable
fortuitously foxtrot fractiousness fruiterer gaieties gaiety garrulous gaudily gaudiness gaudy
genially ghastly gibberish girders glinted glints gnawings gonnegtion grail grotesque grudging gruff
gruffly harlequin harrowed harrowing haughtily haughty hauteur heady hearse highballs hitherto
holocaust homogeneity hulking humidor hydroplane immoderately impassioned impenetrable impetuously
impressionability incalculable incarnation incessant incessantly incoherent inconsequence
incorruptible incredulity incredulous incredulously indecipherable indefinable indeterminate
indignant indignantly indiscernible indiscreet indistinguishably ineffable inexhaustible
inexplicable infantry infinitesimal inhospitably innuendo innumerable inquest inquisitions insidious
insignia insolent interminable intermittent interposed intimation intricate inviolate jauntily
jauntiness jaunty jonquils julep juxtaposition knickerbockers labyrinth laden languid languidly
lather laudable leaden lethargic levity libel libertine loafing luminosity lurch lurched lurches
lustreless luxuriated magnanimous malevolence malice mantelpiece marred medium melancholy melodious
menagerie meretricious mincing modish monograms monopolizing morbid moths moulding murmurous muslin
musty nonolfactory notoriety nymphs obliterated obstetrical obtrusive oculist oggsford omnibus
oppressive oppressiveness orgiastic pandered pap partition pasquinade pavilions peasantry
penitentiary penniless perceptible peremptorily peremptory perishable perturbed pervaded pervading
pigsty plagiaristic plaid plaids pneumatic poise poolroom poolrooms portentous postern precipitately
presumptuous prig prodigality profusion proprietary proprietor provincial proximity punctilious
pungent quavering quickened quickening quivered quivering rajah rakish ramifications rancour
raspingly ravages ravenously receptacles reciprocal recurrent redolent regal relentless relinquished
reposing reproach reproachfully retracted revelation revelations reverent reveries rivulets
roadhouse roadster romp rotogravure rouged roughneck rout roved sardines-in-the-box sauntered
sauterne scalloped scanty sceptically scepticism scrawled scrawny scrutinized scrutiny scurried
sea-change seaboard sedative sensuous sensuously septic serfs settee sheepishly shiftless
shiftlessness shirtwaist shrubbery silhouette sinister slander smirk smouldering snob snobbery
snobbishly soggy somnambulatory spectroscopic sporadic squawk stagnant staid stalked steeple steward
stifling stoop stout straggled strata stretcher strident substantiality subterfuges suggestiveness
sumptuous supercilious superfluous suppressions surmise swank swindler swooned swooning tactfully
tactlessly tangible tapestried tapestry tentatively thatched threadbare throbbed throbbing thudding
tonic torpedoes tortuously tranquil transcendent transit transitory transpired traversed trimalchio
truculent tumult tumultuous turbaned turgid ulster uncommunicable undespairingly unfathomable
uninflected unobtrusively unscrupulously unutterable upholstery vacuous valour veranda verandas
vestibule vestibules vestige vicinity vigil viols vista vulnerable wan wayward wicker wistfully
wistfulness wreath wreaths
""".split()

# Match fixed expressions in their attested forms. Capitalized Sound names the waterway.
PHRASES = (
    r"old sport|a row|bond business|could have sworn|courtesy bay|duck trousers|"
    r"over the counter|private cars?|mint julep|full of money|another bad driver|French windows|"
    r"cuff buttons|the elevated|in the wake of|something funny|glazed eyes|"
    r"get mixed up in|thr(?:ow|ew) me over|resolved itself into|(?:won't|don't) know a soul|"
    r"dead broke|had it coming to him|threw dust into your eyes|Daisy's change' her mine"
)
APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "‑": "-", "–": "-"})


def word_pattern(body, flags=0):
    # Unlike \b, these boundaries also work next to quotes and hyphens.
    return re.compile(r"(?<![^\W\d_])(?:" + body + r")(?![^\W\d_])", flags)


WORD_RE = word_pattern("|".join(re.escape(s) for s in sorted(DIFFICULT_FORMS, key=len, reverse=True)), re.I)
PHRASE_RE = word_pattern(PHRASES, re.I)
SOUND_RE = word_pattern("Sound")


def annotated_span(line, term, occurrence, where):
    starts = [m.start() for m in re.finditer(re.escape(term), line)]
    if occurrence is None:
        if len(starts) != 1:
            raise ValueError(f"{where}: ambiguous or missing anchor {term!r}")
        occurrence = 1
    if type(occurrence) is not int or not 1 <= occurrence <= len(starts):
        raise ValueError(f"{where}: missing occurrence {occurrence} of {term!r}")
    start = starts[occurrence - 1]
    return start, start + len(term)


def check_cue(cue, where):
    en, zh = cue[2:4]
    marks = cue[6] if len(cue) > 6 else []
    spans = {"en": [], "zh": []}
    for mark in marks:
        if len(mark) not in (4, 5) or not all(isinstance(v, str) and v.strip() for v in mark[:4]):
            raise ValueError(f"{where}: incomplete gloss {mark!r}")
        positions = mark[4] if len(mark) == 5 else {}
        if not isinstance(positions, dict) or positions.keys() - spans.keys():
            raise ValueError(f"{where}: invalid occurrence selector {positions!r}")
        for lang, line, term in [("en", en, mark[0]), ("zh", zh, mark[3])]:
            spans[lang].append(annotated_span(line, term, positions.get(lang), where))
    for lang, ranges in spans.items():
        ordered = sorted(ranges)
        if any(left[1] > right[0] for left, right in zip(ordered, ordered[1:])):
            raise ValueError(f"{where}: overlapping {lang} marks")
    for pattern in (WORD_RE, PHRASE_RE, SOUND_RE):
        for match in pattern.finditer(en.translate(APOSTROPHES)):
            if not any(a <= match.start() and match.end() <= b for a, b in spans["en"]):
                raise ValueError(f"{where}: missing difficult expression {match.group()!r}")
    return len(marks)


def main():
    folder = Path(__file__).resolve().parents[1] / "subtitles"
    total = 0
    for chapter in range(1, 10):
        cues = json.loads((folder / f"{chapter:02}.json").read_text(encoding="utf-8"))
        total += sum(check_cue(cue, f"{chapter}/{i}") for i, cue in enumerate(cues))
    print(f"All nine chapters passed, with {total} bilingual annotations.")


if __name__ == "__main__":
    main()
