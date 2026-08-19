# canon-atlas

An atlas over a catalog of markdown documents that reference each other. Point it at a directory and it draws the whole corpus as a constellation: documents as lit spheres, references as gossamer links, semantic clusters as colored regions of the map. Beside the graph sit search, a reader, and, in live mode, editing.

It is agnostic to what wrote the catalog. It was built as the human viewport onto [pi-canon](https://github.com/shaneconner/pi-canon) project memory, where mutable articles carry current ground truth and an immutable journal carries the journey to it, but any folder of markdown with `[[wikilinks]]` or relative links works: an Obsidian vault, a wiki, a notes directory, an agent memory store.

![The constellation over a pi-canon memory store](docs/constellation.png)

## Quick start

```sh
npx canon-atlas build .        # write atlas.html, one self-contained file
npx canon-atlas serve .        # serve the live atlas at http://127.0.0.1:4747/
```

The two modes share one page.

- **build** emits a chart: a single HTML file with the renderer, the graph, and every document inlined. It opens from `file://`, ships as an email attachment, and publishes as a static page. Read only by nature.
- **serve** binds to localhost and puts the corpus behind the same page: create, edit, and delete from the reader panel, with changes on disk immediately. Immutable collections are append-only, so the tool will create a journal entry but never rewrite or delete one.

## Collections

A corpus is described by collections: named groups of documents with their own frontmatter mapping and their own mutability. Without configuration:

- A root holding `articles/` and `journal/` gets the **pi-canon preset**: articles are mutable, the journal is immutable and append-only, `capsule` becomes the summary, a journal entry's `subject` list becomes edges to the articles it concerns, and tags of the form `path:VALUE`, which a migrated store carries as provenance, become source metadata instead of tags.
- Anything else is read as a single mutable collection of notes.

To define your own, put a `canon-atlas.json` at the root:

```json
{
  "title": "team wiki",
  "collections": [
    { "name": "pages", "match": "wiki/" },
    { "name": "decisions", "match": "wiki/adr/", "immutable": true,
      "fields": { "summary": "status", "date": "decided" } }
  ]
}
```

`match` is a directory prefix; the longest prefix claims a file. `fields` maps your frontmatter keys onto the ones the atlas reads: `title`, `tags`, `date`, `summary`, and `refs` (a frontmatter list of documents this one concerns, rendered as edges). Titles fall back to the first heading, then to the path. `immutable` marks a collection append-only and draws its documents as rings instead of spheres.

`reveal` controls how much of a collection sits on the map: `"always"` (the default), `"focus"`, or `"off"`. A `focus` collection stays off the map and out of the layout until you select a document, when its neighbors from that collection bloom around it; searching also surfaces its matches. The collection's chip cycles through revealed-on-focus, shown in full at reduced weight, and hidden. The pi-canon preset marks the journal `focus`: a hundred immutable event entries are detail on demand, not weather. This is why a large corpus reads as a calm sky.

References that resolve nowhere are not errors: they render as dashed, unwritten nodes, because a name the corpus reaches for but has not written yet is a fact worth seeing. In live mode an unwritten node offers to be written.

## Color

Color is the cluster a document belongs to, sampled from one perceptual ramp (Batlow), and the force layout pulls each cluster into its own region, so a band of the palette and a region of the map mean the same thing.

Clusters come from the best signal available:

- **Embeddings**, when the root holds an `embeddings.json` mapping each document path to a vector. Spherical k-means picks the cluster count by silhouette. Bring vectors from any model; the file is the interface.

  ```json
  { "articles/core.md": [0.021, -0.113, ...], "articles/helper.md": [...] }
  ```

- **Link structure** otherwise: deterministic greedy modularity over the reference graph, at zero cost, fully offline.

A header toggle can also color by collection or by tag.

Labels reveal progressively with zoom: the most central documents keep their names at any distance, and the rest earn them as you approach.

## Vocabulary

The tool is the **atlas**. The graph view is the **constellation**. The self-contained file the build emits is a **chart**. A star atlas is a book of constellation maps, and in mathematics an atlas is a collection of charts that together cover a space; both senses are meant.

## Design constraints

- No runtime dependencies. d3 is vendored, everything else is the platform.
- The chart is one file. The only external reference is the Google Fonts stylesheet, and the page falls back to system fonts without it.
- The server binds to 127.0.0.1 only, refuses any path outside the corpus, and enforces collection mutability at the API, not just in the UI.
- Rendered markdown is escaped before anything else touches it; a document cannot inject markup into the page.
- The gate suite is the contract: `node tests/verify.mjs`, every gate green before anything lands.

## Provenance

The constellation rendering is a port of the graph view the author built for the pi-canon project pages, itself descended from a knowledge-graph viewer built for an internal agent harness. The articles and journal framing, one mutable tier of ground truth over one immutable tier of events, comes from pi-canon; the atlas only asks that your corpus be markdown files that name each other.

## License

MIT
