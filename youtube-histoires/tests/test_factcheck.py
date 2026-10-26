from histoires.factcheck import BLOCKING, WARNING, fingerprint, mechanical_checks, verify, write_report


def _all_confirmed(script):
    return {"scenes": [
        {"index": i, "assertions": [{"texte": c["texte"], "verdict": "confirme", "passages": c["passages"],
                                      "explication": "ok"} for c in scene["affirmations"]]}
        for i, scene in enumerate(script["scenes"])
    ]}


def test_clean_script_has_no_blocking_issue(dossier, script):
    issues = mechanical_checks(dossier, script)
    assert not any(item["niveau"] == BLOCKING for items in issues.values() for item in items)


def test_invented_quote_number_and_ids_are_blocking(dossier, script):
    scene = script["scenes"][2]
    scene["narration"] = "En 1979, elle dit : « La forêt est mon seul royaume. »"
    scene["affirmations"].append({"texte": "x", "passages": ["S9-P9"]})
    script["scenes"][1]["visuel"]["image"] = "I7"
    issues = mechanical_checks(dossier, script)
    messages = [item["message"] for item in issues[2] if item["niveau"] == BLOCKING]
    assert any("Citation introuvable" in m for m in messages)
    assert any("« 1979 » absent" in m for m in messages)
    assert any("S9-P9" in m for m in messages)
    assert any("Image inconnue" in item["message"] for item in issues[1])


def test_number_from_uncited_passage_is_a_warning(dossier, script):
    script["scenes"][1]["narration"] += " Elle est récompensée en 2004."
    levels = {item["niveau"] for item in mechanical_checks(dossier, script)[1]}
    assert levels == {WARNING}


def test_verify_revises_until_valid(dossier, script, fake_llm, tmp_path):
    first_check = _all_confirmed(script)
    first_check["scenes"][3]["assertions"].append({
        "texte": "son travail est récompensé par un prix international", "verdict": "non_confirme",
        "passages": [], "explication": "Le dossier ne dit pas que le prix est international.",
    })
    revised_scene = dict(script["scenes"][3], narration="En 2004, elle reçoit un prix pour son travail.")
    llm = fake_llm([first_check, {"scenes": [{"index": 3, "scene": revised_scene}]}, _all_confirmed(script)])

    new_script, report = verify(llm, dossier, script, max_rounds=2, log=lambda *_: None)

    assert report["statut"] == "valide"
    assert report["tours"] == 2
    assert new_script["scenes"][3]["narration"].startswith("En 2004, elle reçoit")
    assert "Scène 3" in llm.tasks[1] and "international" in llm.tasks[1]
    assert report["empreinte_script"] == fingerprint(new_script)
    write_report(report, dossier, tmp_path)
    assert "VALIDÉ" in (tmp_path / "verification.md").read_text(encoding="utf-8")


def test_verify_fails_when_problems_remain(dossier, script, fake_llm):
    check = _all_confirmed(script)
    check["scenes"][0]["assertions"][0]["verdict"] = "contredit"
    llm = fake_llm([check])
    _, report = verify(llm, dossier, script, max_rounds=0, log=lambda *_: None)
    assert report["statut"] == "echec"
    assert report["scenes"][0]["problemes"]
