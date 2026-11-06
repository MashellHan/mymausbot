# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People use MausBot's desktop interface to work with their bots and revisit useful
reports and small applications throughout the day.

## Product Purpose

MausBot is a local-first chat application for a team of agents. Persistent Mini
Apps add a reusable place for bot-authored interfaces backed by the built-in Data
system. Opening and filtering an installed application does not require an AI turn.

## Operating Context

Mini Apps appear as a peer in the existing Computer panel, with navigation between
installed applications. Bots discover and update existing apps across conversations.
The first example is a bookkeeping workspace over previously imported records,
with record, calendar and statistics views, contextual date navigation, period
comparisons and detail drilldowns.

## Capabilities and Constraints

- Reuse the existing Data / DuckDB engine, authoring flow, sandbox and scheduler.
- Preserve the established MausBot interface, themes and keyboard behavior.
- Keep application ownership independent of its source conversation or producer.
- Keep financial currencies separate and preserve unknown or incomplete data.
- Deliver the local version first; cloud publishing is deferred.
- The bookkeeping portal reads existing data; new entry forms and a new scheduler
  are outside this first example.

## Evidence on Hand

The existing application provides Computer tabs, Data views and sandboxed chat
pages. Local inspection confirmed an imported bookkeeping source and established
negative-amount spending semantics. Verification and screenshots use synthetic
records; private transactions and machine identifiers are never example content.
