# Cahier des charges — Fournisseur BytePlus ModelArk (Seedance 2.5 avec personnage IA)

Version 1 — 2 nov 2026
Destinataire : agent de développement (Antigravity) travaillant sur ce dépôt.
Lire `CLAUDE.md` avant de commencer. Tous les textes visibles dans l'app sont en français.

---

## 1. Contexte

SimpleNode (Tauri 2 + Next.js 15, React Flow, zustand) génère images, vidéos et sons via **fal.ai** uniquement (`src-tauri/src/fal.rs`, registre des modèles dans `src-tauri/src/models.rs`, coûts dans `src/lib/cost.ts`, serveur MCP dans `src/lib/mcp.ts` et `src-tauri/src/mcp.rs`).

L'utilisateur produit des vidéos d'un personnage récurrent **généré par IA** (« Nora », femme d'environ 50 ans, rendu photo réaliste).

## 2. Problème

- **Seedance 2.0 / 2.5, mode Draft compris, refuse toute image de départ ou de référence contenant un visage humain réaliste**, même si ce visage a été généré par IA. Message fal : *« The images or videos provided may contain likenesses of real people… »*.
- Cette règle vient de ByteDance et s'applique chez tous les revendeurs (fal, Replicate, ComfyUI…). **fal ne propose aucune voie autorisée** pour la lever.
- **BytePlus ModelArk**, la plateforme officielle de ByteDance, propose deux voies autorisées :
  - **Voie A — bibliothèque privée de portraits virtuels.** On y dépose un personnage IA. BytePlus fait une revue de sécurité, puis l'asset reçoit un identifiant `asset://<id>`, utilisable dans une tâche Seedance avec le rôle `reference_image`. Conditions : le personnage ne ressemble à aucune personne réelle, n'est ni copié ni détourné, ne porte aucun logo de marque. L'activation des « Advanced Creation Rights » et la signature d'une lettre d'autorisation dans la console sont requises à la première création de groupe.
  - **Voie B — sorties de confiance.** Une image avec visage générée par un modèle BytePlus (par ex. Seedream) **sur le même compte et depuis moins de 30 jours** est acceptée comme entrée par Seedance 2.0 / 2.5.

## 3. Objectif

Dans SimpleNode, pouvoir générer des vidéos **Seedance 2.5 (Draft 480p, puis finalisation 1080p)** d'un personnage IA dont le visage est visible, en passant par BytePlus ModelArk, **par les seules voies autorisées A et B**.

## 4. Étape 0 — Vérification de la documentation (obligatoire avant de coder)

Sur `docs.byteplus.com` (section ModelArk), vérifier les points suivants et les consigner dans `docs/byteplus-notes.md`, avec l'URL de chaque source :

| # | À confirmer |
|---|---|
| 0.1 | Authentification : clé API (Bearer) ou signature AK/SK, host et région (ex. `ap-southeast-1`). |
| 0.2 | API de tâche vidéo : création, statut, récupération du résultat, annulation ; identifiant exact du modèle Seedance 2.5 ; durée de conservation des URL de sortie. |
| 0.3 | Champs de la tâche : prompt, premier frame, dernier frame, images de référence (et leurs rôles), durée, format, résolution, audio, graine. |
| 0.4 | Mode Draft (480p) : nom du paramètre, identifiant renvoyé, API de finalisation en 1080p, délai de validité du brouillon. |
| 0.5 | Bibliothèque de portraits virtuels : création de groupe, envoi d'un asset (URL ou fichier), formats et tailles acceptés, statuts de revue, motifs de refus, suppression. |
| 0.6 | Un `asset://` peut-il servir de **premier frame**, ou seulement de `reference_image` ? |
| 0.7 | API image Seedream : identifiant du modèle, et comment une sortie devient « de confiance » (asset ID ? URL ? durée de 30 jours ?). |
| 0.8 | Tarifs (par token ou par seconde, selon la résolution) pour l'estimation des coûts, et limites (QPM, quotas). |

**Si un point n'est pas documenté, l'écrire explicitement dans les notes. Ne rien inventer.** Arrêter et prévenir l'utilisateur si 0.2 ou 0.5 est impossible à confirmer.

## 5. Exigences fonctionnelles

### 5.1 Réglages — clé BytePlus à la charge de l'utilisateur
- **Comme pour fal.ai, chaque utilisateur de SimpleNode apporte son propre compte et sa propre clé BytePlus.** Aucune clé n'est fournie, intégrée au code ou partagée par l'app ; toutes les générations BytePlus sont facturées sur le compte de l'utilisateur.
- Nouveau bloc « BytePlus ModelArk » dans Réglages : clé API (ou AK/SK selon 0.1), région, bouton « Tester la connexion ».
- Stockage identique à celui de la clé fal, dans le fichier privé de l'app (`account.rs`). La clé n'apparaît jamais dans les logs.
- BytePlus est **optionnel** : sans clé, l'app fonctionne comme aujourd'hui. Les nœuds BytePlus restent visibles mais affichent « Ajoutez votre clé BytePlus dans Réglages » au lieu de se lancer.
- Sous le champ, un court guide en français avec liens vers la console BytePlus : créer un compte ModelArk, activer les « Advanced Creation Rights » (nécessaires aux portraits virtuels), signer la lettre d'autorisation à la création du premier groupe de portraits, créer une clé API. Ces étapes se font dans la console BytePlus, par l'utilisateur ; l'app ne les automatise pas.
- Le premier lancement d'un nœud BytePlus rappelle que la facturation passe par le compte BytePlus de l'utilisateur, avec ses propres tarifs et quotas.

### 5.2 Nœud « Portrait IA (BytePlus) » — voie A
- **Entrée** : une image. **Paramètres** : nom du portrait (ex. « Nora »), groupe.
- **Action** : envoie l'image dans la bibliothèque de portraits virtuels, puis interroge le statut jusqu'à la fin de la revue.
- **Affichage** : statut (« En revue », « Validé », « Refusé » avec le motif renvoyé par BytePlus).
- **Sortie** : l'URI `asset://…`, gardée dans le projet. Relancer le nœud ne renvoie pas l'image si l'asset est déjà validé.
- **Rappel affiché dans le nœud** : « Personnage IA uniquement — ne doit ressembler à aucune personne réelle — aucun logo de marque sur l'image. »
- Ce nœud est gratuit ou peu coûteux selon 0.8 : estimer son coût en conséquence.

### 5.3 Nœud « Seedance 2.5 (BytePlus) »
- **Entrées** : Prompt, Prompt négatif (si 0.3 le permet), Image de départ, Image de fin, Portrait (`asset://`, plusieurs possibles si l'API le permet).
- **Réglages** : durée (4–30 s selon la doc), format, audio (oui/non), **Draft (oui/non, oui par défaut)**.
- **Draft** : sortie 480p, avec l'étiquette « Brouillon 480p » et un bouton « Finaliser en 1080p ». Le bouton affiche le prix estimé et demande une confirmation, comme le nœud fal existant, ainsi que la date d'expiration du brouillon (selon 0.4).
- Si une image de départ avec visage est branchée alors que BytePlus la refuse, afficher : « Image refusée par le filtre visage : utilisez un Portrait IA validé ou une image Seedream BytePlus. »

### 5.4 Nœud « Seedream (BytePlus) » — voie B
- Génération d'image (prompt + images de référence si autorisées).
- Les sorties sont marquées « de confiance » avec leur date. Branchées sur Seedance (BytePlus), elles sont transmises **selon le mécanisme prévu par BytePlus** (cf. 0.7), et non comme une simple URL si la doc l'exige.
- Afficher l'expiration (30 jours) sur le nœud.

### 5.5 Coûts et plafond MCP
- `src/lib/cost.ts` : estimation pour chaque nœud BytePlus d'après 0.8 (même logique que l'estimation par tokens de Seedance sur fal).
- `estimate_cost` / `run` du serveur MCP prennent en compte ces nœuds.
- **Correction transverse** : quand le fournisseur (fal **ou** BytePlus) refuse une demande **avant** génération (filtre, validation), le montant estimé est **rendu** au budget MCP de la session. Aujourd'hui, le compteur garde ce montant.

### 5.6 Serveur MCP
- Les nouveaux nœuds apparaissent dans `list_node_types`, avec leurs réglages.
- `finalize_draft` fonctionne aussi pour les Draft BytePlus.
- Nouvel outil `portrait_status { node_id }` qui renvoie le statut de revue et l'URI.

### 5.7 Erreurs
Messages clairs en français : clé invalide, région incorrecte, portrait refusé (avec motif), filtre visage, quota ou QPM dépassé, brouillon expiré, délai dépassé. Les erreurs sont lisibles dans le nœud et dans les réponses MCP.

## 6. Hors périmètre
- Bibliothèque de portraits de **vraies personnes** (vérification d'identité, QR code d'autorisation) : non.
- **Toute technique visant à tromper le filtre** (grille, bruit, déformation, recadrage du visage, etc.) : interdit.
- Suppression ou remplacement des modèles fal existants : non, BytePlus s'ajoute à côté.

## 7. Contraintes techniques
- Respecter l'organisation existante : un module `src-tauri/src/byteplus.rs` à côté de `fal.rs`, des définitions de modèles dans `models.rs` avec un champ fournisseur, et des nœuds React dans `src/components/nodes.tsx`.
- Téléchargement des sorties en local via `storage::download`, comme pour fal.
- MSRV Rust 1.77.2.
- Pendant le développement : **aucune génération réelle**, sauf le test d'acceptation (§ 8) lancé avec l'accord de l'utilisateur.
- Ne pas modifier le Rust pendant qu'une génération tourne dans l'app (redémarrage de `tauri dev`).

## 8. Critères d'acceptation
1. `docs/byteplus-notes.md` existe et répond aux points 0.1 à 0.8, sources à l'appui.
2. « Tester la connexion » réussit avec une clé valide et échoue proprement avec une clé fausse. Sans clé BytePlus, l'app fonctionne comme avant et les nœuds BytePlus indiquent qu'il faut ajouter une clé. Aucune clé ne figure dans le dépôt (vérifier avec une recherche dans le code).
3. Une image de Nora (personnage IA, sans logo) envoyée dans « Portrait IA (BytePlus) » obtient le statut **Validé** et un `asset://`.
4. Un **Draft Seedance 2.5 BytePlus de 5 s** avec ce portrait en référence se génère **sans erreur de visage**. Son coût estimé s'affiche avant le lancement.
5. « Finaliser en 1080p » produit la version 1080p après confirmation du prix.
6. Une demande refusée avant génération ne réduit pas le budget MCP.
7. `npx tsc --noEmit`, `npm run lint`, `cd src-tauri && cargo test && cargo clippy` passent.

## 9. Prérequis côté utilisateur (à sa charge, comme pour fal.ai)
Chaque utilisateur de SimpleNode qui veut les nœuds BytePlus doit, lui-même et sur son compte :
- créer un compte BytePlus ModelArk, authentifié (personne ou entreprise selon les exigences de BytePlus) ;
- activer les « Advanced Creation Rights » et signer la lettre d'autorisation dans la console à la création du premier groupe de portraits ;
- créer une clé API et la saisir dans les Réglages de SimpleNode ;
- respecter les conditions BytePlus pour les portraits virtuels (personnage IA qui ne ressemble à aucune personne réelle, sans logo de marque) : il en est seul responsable.

Pour le test d'acceptation (§ 8), le développeur utilise la clé BytePlus du propriétaire du dépôt, saisie dans les Réglages de son app locale — jamais écrite dans le code, les fichiers du dépôt ou les logs.
