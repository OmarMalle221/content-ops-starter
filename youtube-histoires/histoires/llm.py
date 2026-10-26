"""Appels à Claude : réponses JSON structurées, ancrées dans le dossier de sources."""

from __future__ import annotations

import json

SYSTEM = (
    "Tu travailles pour une chaîne YouTube francophone qui raconte des histoires vraies de "
    "personnes inspirantes. Sa promesse au public : tout ce qui est raconté est vrai et sourcé. "
    "Le message suivant contient un dossier de sources numérotées ; c'est ta seule base factuelle. "
    "N'utilise jamais tes connaissances personnelles pour affirmer un fait, même si tu crois le "
    "connaître : tes souvenirs peuvent être faux ou dépassés, et le spectateur ne pourrait pas les "
    "vérifier dans les sources citées en description."
)


class LLMError(RuntimeError):
    pass


class Claude:
    """Client minimal : le dossier est placé en tête et mis en cache entre les appels
    (rédaction, vérification, corrections), seule la consigne change."""

    def __init__(self, model: str, effort: str = "high", log=print):
        import anthropic

        self._anthropic = anthropic
        self.client = anthropic.Anthropic()
        self.model = model
        self.effort = effort
        self.log = log

    def json(self, dossier_prompt: str, task: str, schema: dict, max_tokens: int = 64000) -> dict:
        anthropic = self._anthropic
        try:
            with self.client.beta.messages.stream(
                model=self.model,
                max_tokens=max_tokens,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                thinking={"type": "adaptive"},
                output_config={
                    "effort": self.effort,
                    "format": {"type": "json_schema", "schema": schema},
                },
                system=SYSTEM,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": dossier_prompt, "cache_control": {"type": "ephemeral"}},
                            {"type": "text", "text": task},
                        ],
                    }
                ],
            ) as stream:
                message = stream.get_final_message()
        except anthropic.AuthenticationError as error:
            raise LLMError("Clé API Anthropic invalide ou absente (ANTHROPIC_API_KEY).") from error
        except anthropic.RateLimitError as error:
            raise LLMError("Limite de débit de l'API atteinte, réessayez dans une minute.") from error
        except anthropic.APIStatusError as error:
            raise LLMError(f"Erreur de l'API Anthropic ({error.status_code}) : {error.message}") from error
        except anthropic.APIConnectionError as error:
            raise LLMError("Impossible de joindre l'API Anthropic (connexion réseau).") from error

        if message.stop_reason == "refusal":
            raise LLMError("Le modèle a refusé la demande.")
        if message.stop_reason == "max_tokens":
            raise LLMError("Réponse tronquée (max_tokens atteint) : raccourcissez la vidéo.")
        usage = message.usage
        self.log(
            f"    [{message.model}] entrée {usage.input_tokens} + cache {usage.cache_read_input_tokens or 0}"
            f" jetons, sortie {usage.output_tokens} jetons"
        )
        # Après un éventuel basculement de modèle, seule la réponse finale compte.
        blocks = list(message.content)
        last_fallback = max((i for i, block in enumerate(blocks) if block.type == "fallback"), default=-1)
        texts = [block.text for block in blocks[last_fallback + 1:] if block.type == "text"]
        if not texts:
            raise LLMError("Réponse vide du modèle.")
        try:
            return json.loads(texts[-1])
        except json.JSONDecodeError as error:
            raise LLMError("Réponse JSON invalide du modèle.") from error
