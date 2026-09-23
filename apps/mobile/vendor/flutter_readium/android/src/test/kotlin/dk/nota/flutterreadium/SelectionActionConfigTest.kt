package dk.nota.flutterreadium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The navigator picks its ActionMode callback from these at creation, so the
 * creation params must parse the same way as `configureSelectionActions`.
 */
class SelectionActionConfigTest {
    @Test fun parsesDartSelectionActions() {
        val raw = listOf(
            mapOf("id" to "highlight", "title" to "Highlight"),
            mapOf("id" to "copy", "title" to "Copy"),
        )
        assertEquals(
            listOf(SelectionActionConfig("highlight", "Highlight"), SelectionActionConfig("copy", "Copy")),
            SelectionActionConfig.parseList(raw),
        )
    }

    @Test fun dropsMalformedEntriesAndDefaultsTheTitle() {
        val raw = listOf(mapOf("title" to "No id"), "junk", mapOf("id" to "note"))
        assertEquals(listOf(SelectionActionConfig("note", "note")), SelectionActionConfig.parseList(raw))
    }

    @Test fun missingParamIsEmpty() {
        assertEquals(emptyList<SelectionActionConfig>(), SelectionActionConfig.parseList(null))
    }
}
