# Recast glossary

Recast follows YouTube channels and turns each new video into an article to read instead of watch. Use these English terms in code and engineering discussions; the Brazilian Portuguese interface uses their translations.

## Domain language

**Channel** (`Channel`):
A YouTube channel the user has chosen to follow. The source channel of an Ad Hoc Video is not a Channel.
_Avoid_: Subscription, feed, source

**Video** (`Video`):
An ordinary YouTube publication. Shorts, livestreams (including completed ones), and members-only videos are not Videos; a premiere becomes a Video once available.
_Avoid_: Episode, upload, item

**Ad Hoc Video** (`AdHocVideo`):
A Video requested directly by the user, rather than detected on a Channel.
_Avoid_: Manual video, one-off video

**Transcript** (`Transcript`):
A Video's spoken text, in its original language, with timestamps.
_Avoid_: Subtitle, caption

**Article** (`Article`):
Text written in the Article Language from a Transcript, with a short opening summary followed by a body divided into sections.
_Avoid_: Summary, recap

**Article Language** (`ArticleLanguage`):
The language, as a BCP 47 code, that every Article and its Delivery are written in, whatever the language of the Video. The selection is global across Videos.
_Avoid_: Locale, interface language

**Global Prompt** (`GlobalPrompt`):
Instructions defining the format of every Article, shared across Videos.
_Avoid_: Default prompt, template

**Channel Instructions** (`ChannelInstructions`):
Channel-specific guidance that complements the Global Prompt. An Ad Hoc Video has no Channel Instructions.
_Avoid_: Channel prompt, custom prompt

**Generation Provider** (`GenerationProvider`):
The AI service selected by the user to turn Transcripts into Articles. The selection is global across Videos.
_Avoid_: Model, SDK, account

**Generation Model** (`GenerationModel`):
The AI model selected within a Generation Provider to write Articles. Each Generation Provider has its own global model selection.
_Avoid_: Provider, engine, SDK

**Generation Usage** (`GenerationUsage`):
The consumption attributed to an attempt to write an Article, identified by its Generation Provider and Generation Model. Consumption may exist even when the attempt does not produce a completed Article.
_Avoid_: Cost, billing

**Estimated Generation Cost** (`EstimatedGenerationCost`):
The estimated monetary value of Generation Usage, including an equivalent value for consumption covered by a subscription. It is distinct from the amount actually billed; an unknown estimate is not zero.
_Avoid_: Actual charge, invoice amount

**Stage** (`Stage`):
One of the four steps a Video passes through, in order: Download, Transcription, Article, and Delivery.
_Avoid_: Phase, step, job

**Delivery** (`Delivery`):
Sending the Article to the user by email.
_Avoid_: Notification, dispatch
