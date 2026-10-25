// Les deux familles FICTIVES du pilote (données d'exemple), sous forme de réponses au questionnaire.
import type { BenefitAnswers } from '../../src/shared/benefits/engine';

/** Famille A : une mère de 82 ans qui vit chez elle ; sa fille l'aide sans habiter avec elle. */
export const FAMILY_A: BenefitAnswers = {
    recipient_age: 82,
    living_setting: 'home',
    pays_home_support_services: 'yes', // ménage aux deux semaines
    domestic_help: 'yes',
    severe_prolonged_impairment: 'unknown', // jamais évaluée
    impairment_dependency: 'unknown',
    caregiver_cohabits: 'no',
    needs_home_adaptation: 'yes' // bain difficile d'accès
};

/** Famille B : un père de 79 ans en résidence privée pour aînés, en attente d'une place en CHSLD. */
export const FAMILY_B: BenefitAnswers = {
    recipient_age: 79,
    living_setting: 'rpa',
    pays_home_support_services: 'yes', // services compris dans le bail de la résidence
    domestic_help: 'no',
    severe_prolonged_impairment: 'yes',
    impairment_dependency: 'yes',
    caregiver_cohabits: 'no',
    needs_home_adaptation: 'no'
};
