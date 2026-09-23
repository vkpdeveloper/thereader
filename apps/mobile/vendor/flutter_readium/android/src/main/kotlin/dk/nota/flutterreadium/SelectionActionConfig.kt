package dk.nota.flutterreadium

/**
 * Represents a configured selection action from Dart.
 * These map to custom context menu items shown when text is selected.
 */
data class SelectionActionConfig(
    val id: String,
    val title: String,
) {
    companion object {
        /**
         * THEREADER PATCH: parses the `selectionActions` creation param (and the
         * `configureSelectionActions` call), a list of `{id, title}` maps.
         * Entries without an id are dropped.
         */
        fun parseList(raw: Any?): List<SelectionActionConfig> =
            (raw as? List<*>).orEmpty().mapNotNull { entry ->
                val map = entry as? Map<*, *> ?: return@mapNotNull null
                val id = map["id"] as? String
                if (id.isNullOrEmpty()) return@mapNotNull null
                SelectionActionConfig(id = id, title = map["title"] as? String ?: id)
            }
    }
}
