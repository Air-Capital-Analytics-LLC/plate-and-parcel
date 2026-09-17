/**
 * config.js — the only file you need to edit.
 *
 * Fill in dbUrl from your Firebase Realtime Database, then save. Nothing else
 * in this project needs changing.
 */
export const CONFIG = {
  // Firebase → Realtime Database → the URL shown at the top of the Data tab.
  // Looks like: https://something-default-rtdb.firebaseio.com
  // (or ...-default-rtdb.europe-west1.firebasedatabase.app)
  dbUrl: 'https://plate-and-parcel-default-rtdb.firebaseio.com',

  // Any short word. Lets one database hold more than one list later.
  listId: 'household',

  // true  = everyone types a shared passphrase once per phone, and the list
  //         contents are encrypted before they reach Firebase.
  // false = no passphrase; anyone with the link can read and edit.
  requirePassphrase: true,
};
