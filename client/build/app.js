(function () {
'use strict';

function ntoh(bytes, offset=0) {
    return (bytes[3 + offset] << 0) |
           (bytes[2 + offset] << 8) |
           (bytes[1 + offset] << 16) |
           (bytes[0 + offset] << 24)
}

// Fisher-Yates Shuffle
function shuffle(array) {
    let counter = array.length;
    let temp;
    let index;

    // While there are elements in the array
    while (counter > 0) {
        // Pick a random index
        index = Math.floor(Math.random() * counter);
        counter -= 1;

        // And swap the last element with it
        temp = array[counter];
        array[counter] = array[index];
        array[index] = temp;
    }

    return array
}

class Album {
    constructor(id, title, albumArtist, year, tracks) {
        this.id = id;
        this.title = title;
        this.albumArtist = albumArtist;
        this.year = year;
        this.tracks = tracks;
        this.thumbnail = null;

        this.haveCover = true;
    }

    compare(other) {
        const thisCompiler = this.albumArtist.toLowerCase().split(/^"|the\W/i).join('');
        const otherCompiler = other.albumArtist.toLowerCase().split(/^"|the\W/i).join('');

        if(thisCompiler > otherCompiler) { return 1 }
        if(thisCompiler < otherCompiler) { return -1 }

        // Tie-break using year
        if(this.year > other.year) { return 1 }
        if(this.year < other.year) { return -1 }

        return 0
    }

    static parse(data) {
        return new Album(data.id, data.title, data.album_artist, data.year, data.tracks)
    }
}

class Song {
    constructor(id, title, artist) {
        this.id = id;
        this.title = title;
        this.artist = artist;
    }

    stream() {
        return `/music/song/${this.id}/stream`
    }

    static parse(data) {
        return new Song(data.id, data.title, data.artist)
    }
}

class MediaLibrary {
    constructor(root) {
        this.root = root;

        this.songs = [];
        this.albums = [];
        this.thumbnails = new Map();

        this.songCache = new Map();
        this.albumCache = new Map();

        // this.artistIndex = new Map()
        this.albumIndex = new Map();
    }

    async refresh() {
        const songs = [];
        const songCache = new Map();
        const newAlbumIndex = new Map();

        try {
            const response = await self.fetch(`${this.root}/music/songs`);
            const results = await response.json();
            for(const rawSong of Object.values(results)) {
                songs.push(rawSong.id);
                newAlbumIndex.set(rawSong.id, rawSong.album_id);

                try {
                    songCache.set(rawSong.id, Song.parse(rawSong));
                } catch(err) {
                    console.error(`Error parsing song ${rawSong.id}`);
                    console.error(err);
                }
            }
        } catch (err) {
            console.error('Error getting song manifest', err);
            return
        }

        this.songs = songs;
        this.songCache = songCache;
        this.albumIndex = newAlbumIndex;
        this.albums = await this.getAlbums();

        await this.getThumbnails();
    }

    async shuffle() {
        await this.refresh();
        shuffle(this.songs);
        return this.songs
    }

    songUrl(song) {
        return this.root + song.stream()
    }

    getSong(id) {
        if(this.songCache.has(id)) {
            return this.songCache.get(id)
        } else {
            return null
        }
    }

    getCover(album) {
        return `${this.root}/music/album/${album.id}/cover`
    }

    async getThumbnails() {
        const albumList = Array.from(this.albums);
        const query = albumList.map((album) => encodeURIComponent(album.id)).join(',');
        const response = await fetch(`${this.root}/music/thumbnail?ids=${query}`);
        const body = await response.arrayBuffer();
        const view = new Uint8Array(body);

        let offset = 0;
        const thumbnails = [];
        while (offset < view.length) {
            const messageLength = ntoh(view, offset);
            offset += 4;

            if (messageLength === 0) {
                thumbnails.push(null);
                continue
            }

            const blob = new Blob([view.slice(offset, messageLength + offset)], { type: 'image/jpeg' });
            offset += messageLength;
            const url = URL.createObjectURL(blob);
            thumbnails.push(url);
        }

        for (const albumID of this.thumbnails.keys()) {
            URL.revokeObjectURL(this.thumbnails.get(albumID));
        }

        this.thumbnails.clear();
        for (let i = 0; i < thumbnails.length; i += 1) {
            if (thumbnails[i] !== null) {
                this.thumbnails.set(albumList[i].id, thumbnails[i]);
            }
        }
    }

    async getAlbums() {
        const response = await self.fetch(`${this.root}/music/albums`);
        const data = await response.json();
        const albums = [];
        for (const rawAlbum of Object.values(data)) {
            const album = Album.parse(rawAlbum);
            this.albumCache.set(album.id, album);
            albums.push(album);
        }

        return albums
    }

    async getAlbum(id) {
        if(this.albumCache.has(id)) {
            return this.albumCache.get(id)
        }

        const response = await self.fetch(`${this.root}/music/album/${id}/metadata`);
        const data = await response.json();
        const album = Album.parse(data);
        this.albumCache.set(id, album);
        return album
    }

    getAlbumBySong(id) {
        return this.getAlbum(this.albumIndex.get(id))
    }
}

function noop() {}

function assign(target) {
	var k,
		source,
		i = 1,
		len = arguments.length;
	for (; i < len; i++) {
		source = arguments[i];
		for (k in source) target[k] = source[k];
	}

	return target;
}

function appendNode(node, target) {
	target.appendChild(node);
}

function insertNode(node, target, anchor) {
	target.insertBefore(node, anchor);
}

function detachNode(node) {
	node.parentNode.removeChild(node);
}

// TODO this is out of date
function destroyEach(iterations, detach, start) {
	for (var i = start; i < iterations.length; i += 1) {
		if (iterations[i]) iterations[i].destroy(detach);
	}
}

function createElement(name) {
	return document.createElement(name);
}

function createText(data) {
	return document.createTextNode(data);
}

function createComment() {
	return document.createComment('');
}

function addListener(node, event, handler) {
	node.addEventListener(event, handler, false);
}

function removeListener(node, event, handler) {
	node.removeEventListener(event, handler, false);
}

function setAttribute(node, attribute, value) {
	node.setAttribute(attribute, value);
}

function destroy(detach) {
	this.destroy = noop;
	this.fire('destroy');
	this.set = this.get = noop;

	if (detach !== false) this._fragment.unmount();
	this._fragment.destroy();
	this._fragment = this._state = null;
}

function destroyDev(detach) {
	destroy.call(this, detach);
	this.destroy = function() {
		console.warn('Component was already destroyed');
	};
}

function differs(a, b) {
	return a !== b || ((a && typeof a === 'object') || typeof a === 'function');
}

function dispatchObservers(component, group, changed, newState, oldState) {
	for (var key in group) {
		if (!changed[key]) continue;

		var newValue = newState[key];
		var oldValue = oldState[key];

		var callbacks = group[key];
		if (!callbacks) continue;

		for (var i = 0; i < callbacks.length; i += 1) {
			var callback = callbacks[i];
			if (callback.__calling) continue;

			callback.__calling = true;
			callback.call(component, newValue, oldValue);
			callback.__calling = false;
		}
	}
}

function get(key) {
	return key ? this._state[key] : this._state;
}

function fire(eventName, data) {
	var handlers =
		eventName in this._handlers && this._handlers[eventName].slice();
	if (!handlers) return;

	for (var i = 0; i < handlers.length; i += 1) {
		handlers[i].call(this, data);
	}
}

function observe(key, callback, options) {
	var group = options && options.defer
		? this._observers.post
		: this._observers.pre;

	(group[key] || (group[key] = [])).push(callback);

	if (!options || options.init !== false) {
		callback.__calling = true;
		callback.call(this, this._state[key]);
		callback.__calling = false;
	}

	return {
		cancel: function() {
			var index = group[key].indexOf(callback);
			if (~index) group[key].splice(index, 1);
		}
	};
}

function observeDev(key, callback, options) {
	var c = (key = '' + key).search(/[^\w]/);
	if (c > -1) {
		var message =
			'The first argument to component.observe(...) must be the name of a top-level property';
		if (c > 0)
			message += ", i.e. '" + key.slice(0, c) + "' rather than '" + key + "'";

		throw new Error(message);
	}

	return observe.call(this, key, callback, options);
}

function on(eventName, handler) {
	if (eventName === 'teardown') return this.on('destroy', handler);

	var handlers = this._handlers[eventName] || (this._handlers[eventName] = []);
	handlers.push(handler);

	return {
		cancel: function() {
			var index = handlers.indexOf(handler);
			if (~index) handlers.splice(index, 1);
		}
	};
}

function onDev(eventName, handler) {
	if (eventName === 'teardown') {
		console.warn(
			"Use component.on('destroy', ...) instead of component.on('teardown', ...) which has been deprecated and will be unsupported in Svelte 2"
		);
		return this.on('destroy', handler);
	}

	return on.call(this, eventName, handler);
}

function set(newState) {
	this._set(assign({}, newState));
	if (this._root._lock) return;
	this._root._lock = true;
	callAll(this._root._beforecreate);
	callAll(this._root._oncreate);
	callAll(this._root._aftercreate);
	this._root._lock = false;
}

function _set(newState) {
	var oldState = this._state,
		changed = {},
		dirty = false;

	for (var key in newState) {
		if (differs(newState[key], oldState[key])) changed[key] = dirty = true;
	}
	if (!dirty) return;

	this._state = assign({}, oldState, newState);
	this._recompute(changed, this._state, oldState, false);
	if (this._bind) this._bind(changed, this._state);
	dispatchObservers(this, this._observers.pre, changed, this._state, oldState);
	this._fragment.update(changed, this._state);
	dispatchObservers(this, this._observers.post, changed, this._state, oldState);
}

function _setDev(newState) {
	if (typeof newState !== 'object') {
		throw new Error(
			this._debugName + ' .set was called without an object of data key-values to update.'
		);
	}

	this._checkReadOnly(newState);
	_set.call(this, newState);
}

function callAll(fns) {
	while (fns && fns.length) fns.pop()();
}

function _mount(target, anchor) {
	this._fragment.mount(target, anchor);
}

function _unmount() {
	this._fragment.unmount();
}

var protoDev = {
	destroy: destroyDev,
	get: get,
	fire: fire,
	observe: observeDev,
	on: onDev,
	set: set,
	teardown: destroyDev,
	_recompute: noop,
	_set: _setDev,
	_mount: _mount,
	_unmount: _unmount
};

var template = (function() {
return {
    data () {
        return {
            show: false
        };
    }
};
}());

function encapsulateStyles(node) {
	setAttribute(node, "svelte-3994211942", "");
}

function add_css() {
	var style = createElement("style");
	style.id = 'svelte-3994211942-style';
	style.textContent = "[svelte-3994211942].album-list,[svelte-3994211942] .album-list{display:flex;flex-wrap:wrap;position:absolute;top:50px}[svelte-3994211942].album-list > div,[svelte-3994211942] .album-list > div{background-color:#444;color:white;font-size:80%;font-family:sans-serif;width:100px;height:100px;background-size:cover;margin-left:2px;margin-right:2px;cursor:pointer;position:relative;transition:all 0.25s;display:flex;flex-direction:column;align-items:center;justify-content:center;user-select:none;-moz-user-select:none;-webkit-user-select:none}[svelte-3994211942].album-list > div > div,[svelte-3994211942] .album-list > div > div{padding-top:5px;padding-bottom:5px;pointer-events:none}[svelte-3994211942].album-list > div:active,[svelte-3994211942] .album-list > div:active{top:-6px}[svelte-3994211942].album-list > div:first-child,[svelte-3994211942] .album-list > div:first-child{font-size:100%;background-color:transparent}\n/*# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQWxidW1zVmlldy5odG1sIiwic291cmNlcyI6WyJBbGJ1bXNWaWV3Lmh0bWwiXSwic291cmNlc0NvbnRlbnQiOlsie3sgI2lmIHNob3cgfX1cbjxkaXYgY2xhc3M9XCJhbGJ1bS1saXN0XCI+XG4gICAgPGRpdiBvbjpjbGljaz1cImZpcmUoJ3NodWZmbGUnKVwiPlxuICAgICAgICA8c3BhbiBjbGFzcz1cImZhIGZhLXJhbmRvbVwiIHRpdGxlPVwiU2h1ZmZsZVwiPjwvc3Bhbj5cbiAgICA8L2Rpdj5cblxuICAgIHt7ICNlYWNoIGxpYnJhcnkuYWxidW1zIGFzIGFsYnVtIH19XG4gICAgPGRpdiBvbjpjbGljaz1cImZpcmUoJ3NlbGVjdCcsIGFsYnVtKVwiPlxuICAgIHt7ICNpZiBsaWJyYXJ5LnRodW1ibmFpbHMuaGFzKGFsYnVtLmlkKSB9fVxuICAgICAgICA8aW1nIHdpZHRoPTEwMCBoZWlnaHQ9MTAwIHNyYz1cInt7IGxpYnJhcnkudGh1bWJuYWlscy5nZXQoYWxidW0uaWQpIH19XCIgYWx0PVwie3sgYWxidW0uYWxidW1BcnRpc3QgfX0gLSB7eyBhbGJ1bS50aXRsZSB9fVwiPlxuICAgIHt7IGVsc2UgfX1cbiAgICAgICAgPGRpdj57eyBhbGJ1bS5hbGJ1bUFydGlzdCB9fTwvZGl2PlxuICAgICAgICA8ZGl2Pnt7IGFsYnVtLnRpdGxlIH19PC9kaXY+XG4gICAge3sgL2lmIH19XG4gICAgPC9kaXY+XG4gICAge3sgL2VhY2ggfX1cbjwvZGl2Plxue3sgL2lmIH19XG5cbjxzdHlsZT5cbi5hbGJ1bS1saXN0IHtcbiAgICBkaXNwbGF5OiBmbGV4O1xuICAgIGZsZXgtd3JhcDogd3JhcDtcbiAgICBwb3NpdGlvbjogYWJzb2x1dGU7XG4gICAgdG9wOiA1MHB4O1xufVxuXG4uYWxidW0tbGlzdCA+IGRpdiB7XG4gICAgYmFja2dyb3VuZC1jb2xvcjogIzQ0NDtcbiAgICBjb2xvcjogd2hpdGU7XG4gICAgZm9udC1zaXplOiA4MCU7XG4gICAgZm9udC1mYW1pbHk6IHNhbnMtc2VyaWY7XG4gICAgd2lkdGg6IDEwMHB4O1xuICAgIGhlaWdodDogMTAwcHg7XG4gICAgYmFja2dyb3VuZC1zaXplOiBjb3ZlcjtcbiAgICBtYXJnaW4tbGVmdDogMnB4O1xuICAgIG1hcmdpbi1yaWdodDogMnB4O1xuXG4gICAgY3Vyc29yOiBwb2ludGVyO1xuICAgIHBvc2l0aW9uOiByZWxhdGl2ZTtcbiAgICB0cmFuc2l0aW9uOiBhbGwgMC4yNXM7XG5cbiAgICBkaXNwbGF5OiBmbGV4O1xuICAgIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47XG4gICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjtcblxuICAgIHVzZXItc2VsZWN0OiBub25lO1xuICAgIC1tb3otdXNlci1zZWxlY3Q6IG5vbmU7XG4gICAgLXdlYmtpdC11c2VyLXNlbGVjdDogbm9uZTtcbn1cblxuLmFsYnVtLWxpc3QgPiBkaXYgPiBkaXYge1xuICAgIHBhZGRpbmctdG9wOiA1cHg7XG4gICAgcGFkZGluZy1ib3R0b206IDVweDtcbiAgICBwb2ludGVyLWV2ZW50czogbm9uZTtcbn1cblxuLmFsYnVtLWxpc3QgPiBkaXY6YWN0aXZlIHsgdG9wOiAtNnB4OyB9XG5cbi5hbGJ1bS1saXN0ID4gZGl2OmZpcnN0LWNoaWxkIHtcbiAgICBmb250LXNpemU6IDEwMCU7XG4gICAgYmFja2dyb3VuZC1jb2xvcjogdHJhbnNwYXJlbnQ7XG59XG48L3N0eWxlPlxuXG48c2NyaXB0PlxuZXhwb3J0IGRlZmF1bHQge1xuICAgIGRhdGEgKCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgc2hvdzogZmFsc2VcbiAgICAgICAgfTtcbiAgICB9XG59O1xuPC9zY3JpcHQ+XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBb0JBLDhEQUFZLENBQUMsQUFDVCxPQUFPLENBQUUsSUFBSSxDQUNiLFNBQVMsQ0FBRSxJQUFJLENBQ2YsUUFBUSxDQUFFLFFBQVEsQ0FDbEIsR0FBRyxDQUFFLElBQUksQUFDYixDQUFDLEFBRUQsMEVBQWtCLENBQUMsQUFDZixnQkFBZ0IsQ0FBRSxJQUFJLENBQ3RCLEtBQUssQ0FBRSxLQUFLLENBQ1osU0FBUyxDQUFFLEdBQUcsQ0FDZCxXQUFXLENBQUUsVUFBVSxDQUN2QixLQUFLLENBQUUsS0FBSyxDQUNaLE1BQU0sQ0FBRSxLQUFLLENBQ2IsZUFBZSxDQUFFLEtBQUssQ0FDdEIsV0FBVyxDQUFFLEdBQUcsQ0FDaEIsWUFBWSxDQUFFLEdBQUcsQ0FFakIsTUFBTSxDQUFFLE9BQU8sQ0FDZixRQUFRLENBQUUsUUFBUSxDQUNsQixVQUFVLENBQUUsR0FBRyxDQUFDLEtBQUssQ0FFckIsT0FBTyxDQUFFLElBQUksQ0FDYixjQUFjLENBQUUsTUFBTSxDQUN0QixXQUFXLENBQUUsTUFBTSxDQUNuQixlQUFlLENBQUUsTUFBTSxDQUV2QixXQUFXLENBQUUsSUFBSSxDQUNqQixnQkFBZ0IsQ0FBRSxJQUFJLENBQ3RCLG1CQUFtQixDQUFFLElBQUksQUFDN0IsQ0FBQyxBQUVELHNGQUF3QixDQUFDLEFBQ3JCLFdBQVcsQ0FBRSxHQUFHLENBQ2hCLGNBQWMsQ0FBRSxHQUFHLENBQ25CLGNBQWMsQ0FBRSxJQUFJLEFBQ3hCLENBQUMsQUFFRCx3RkFBeUIsQ0FBQyxBQUFDLEdBQUcsQ0FBRSxJQUFJLEFBQUUsQ0FBQyxBQUV2QyxrR0FBOEIsQ0FBQyxBQUMzQixTQUFTLENBQUUsSUFBSSxDQUNmLGdCQUFnQixDQUFFLFdBQVcsQUFDakMsQ0FBQyJ9 */";
	appendNode(style, document.head);
}

function create_main_fragment(state, component) {
	var if_block_anchor;

	var if_block = (state.show) && create_if_block(state, component);

	return {
		create: function() {
			if (if_block) if_block.create();
			if_block_anchor = createComment();
		},

		mount: function(target, anchor) {
			if (if_block) if_block.mount(target, anchor);
			insertNode(if_block_anchor, target, anchor);
		},

		update: function(changed, state) {
			if (state.show) {
				if (if_block) {
					if_block.update(changed, state);
				} else {
					if_block = create_if_block(state, component);
					if_block.create();
					if_block.mount(if_block_anchor.parentNode, if_block_anchor);
				}
			} else if (if_block) {
				if_block.unmount();
				if_block.destroy();
				if_block = null;
			}
		},

		unmount: function() {
			if (if_block) if_block.unmount();
			detachNode(if_block_anchor);
		},

		destroy: function() {
			if (if_block) if_block.destroy();
		}
	};
}

function create_each_block(state, each_block_value, album, album_index, component) {
	var div;

	var current_block_type = select_block_type(state, each_block_value, album, album_index);
	var if_block = current_block_type(state, each_block_value, album, album_index, component);

	return {
		create: function() {
			div = createElement("div");
			if_block.create();
			this.hydrate();
		},

		hydrate: function(nodes) {
			addListener(div, "click", click_handler);

			div._svelte = {
				component: component,
				each_block_value: each_block_value,
				album_index: album_index
			};
		},

		mount: function(target, anchor) {
			insertNode(div, target, anchor);
			if_block.mount(div, null);
		},

		update: function(changed, state, each_block_value, album, album_index) {
			div._svelte.each_block_value = each_block_value;
			div._svelte.album_index = album_index;

			if (current_block_type === (current_block_type = select_block_type(state, each_block_value, album, album_index)) && if_block) {
				if_block.update(changed, state, each_block_value, album, album_index);
			} else {
				if_block.unmount();
				if_block.destroy();
				if_block = current_block_type(state, each_block_value, album, album_index, component);
				if_block.create();
				if_block.mount(div, null);
			}
		},

		unmount: function() {
			detachNode(div);
			if_block.unmount();
		},

		destroy: function() {
			removeListener(div, "click", click_handler);
			if_block.destroy();
		}
	};
}

function create_if_block_1(state, each_block_value, album, album_index, component) {
	var img, img_src_value, img_alt_value;

	return {
		create: function() {
			img = createElement("img");
			this.hydrate();
		},

		hydrate: function(nodes) {
			img.width = "100";
			img.height = "100";
			img.src = img_src_value = state.library.thumbnails.get(album.id);
			img.alt = img_alt_value = "" + album.albumArtist + " - " + album.title;
		},

		mount: function(target, anchor) {
			insertNode(img, target, anchor);
		},

		update: function(changed, state, each_block_value, album, album_index) {
			if ( (changed.library) && img_src_value !== (img_src_value = state.library.thumbnails.get(album.id)) ) {
				img.src = img_src_value;
			}

			if ( (changed.library) && img_alt_value !== (img_alt_value = "" + album.albumArtist + " - " + album.title) ) {
				img.alt = img_alt_value;
			}
		},

		unmount: function() {
			detachNode(img);
		},

		destroy: noop
	};
}

function create_if_block_2(state, each_block_value, album, album_index, component) {
	var div, text_value = album.albumArtist, text, text_1, div_1, text_2_value = album.title, text_2;

	return {
		create: function() {
			div = createElement("div");
			text = createText(text_value);
			text_1 = createText("\n        ");
			div_1 = createElement("div");
			text_2 = createText(text_2_value);
		},

		mount: function(target, anchor) {
			insertNode(div, target, anchor);
			appendNode(text, div);
			insertNode(text_1, target, anchor);
			insertNode(div_1, target, anchor);
			appendNode(text_2, div_1);
		},

		update: function(changed, state, each_block_value, album, album_index) {
			if ( (changed.library) && text_value !== (text_value = album.albumArtist) ) {
				text.data = text_value;
			}

			if ( (changed.library) && text_2_value !== (text_2_value = album.title) ) {
				text_2.data = text_2_value;
			}
		},

		unmount: function() {
			detachNode(div);
			detachNode(text_1);
			detachNode(div_1);
		},

		destroy: noop
	};
}

function create_if_block(state, component) {
	var div, div_1, span, text_1;

	function click_handler(event) {
		component.fire('shuffle');
	}

	var each_block_value = state.library.albums;

	var each_block_iterations = [];

	for (var i = 0; i < each_block_value.length; i += 1) {
		each_block_iterations[i] = create_each_block(state, each_block_value, each_block_value[i], i, component);
	}

	return {
		create: function() {
			div = createElement("div");
			div_1 = createElement("div");
			span = createElement("span");
			text_1 = createText("\n\n    ");

			for (var i = 0; i < each_block_iterations.length; i += 1) {
				each_block_iterations[i].create();
			}
			this.hydrate();
		},

		hydrate: function(nodes) {
			encapsulateStyles(div);
			div.className = "album-list";
			addListener(div_1, "click", click_handler);
			span.className = "fa fa-random";
			span.title = "Shuffle";
		},

		mount: function(target, anchor) {
			insertNode(div, target, anchor);
			appendNode(div_1, div);
			appendNode(span, div_1);
			appendNode(text_1, div);

			for (var i = 0; i < each_block_iterations.length; i += 1) {
				each_block_iterations[i].mount(div, null);
			}
		},

		update: function(changed, state) {
			var each_block_value = state.library.albums;

			if (changed.library) {
				for (var i = 0; i < each_block_value.length; i += 1) {
					if (each_block_iterations[i]) {
						each_block_iterations[i].update(changed, state, each_block_value, each_block_value[i], i);
					} else {
						each_block_iterations[i] = create_each_block(state, each_block_value, each_block_value[i], i, component);
						each_block_iterations[i].create();
						each_block_iterations[i].mount(div, null);
					}
				}

				for (; i < each_block_iterations.length; i += 1) {
					each_block_iterations[i].unmount();
					each_block_iterations[i].destroy();
				}
				each_block_iterations.length = each_block_value.length;
			}
		},

		unmount: function() {
			detachNode(div);

			for (var i = 0; i < each_block_iterations.length; i += 1) {
				each_block_iterations[i].unmount();
			}
		},

		destroy: function() {
			removeListener(div_1, "click", click_handler);

			destroyEach(each_block_iterations, false, 0);
		}
	};
}

function click_handler(event) {
	var component = this._svelte.component;
	var each_block_value = this._svelte.each_block_value, album_index = this._svelte.album_index, album = each_block_value[album_index];
	component.fire('select', album);
}

function select_block_type(state, each_block_value, album, album_index) {
	if (state.library.thumbnails.has(album.id)) return create_if_block_1;
	return create_if_block_2;
}

function AlbumsView(options) {
	this._debugName = '<AlbumsView>';
	if (!options || (!options.target && !options._root)) throw new Error("'target' is a required option");
	this.options = options;
	this._state = assign(template.data(), options.data);
	if (!('show' in this._state)) console.warn("<AlbumsView> was created without expected data property 'show'");
	if (!('library' in this._state)) console.warn("<AlbumsView> was created without expected data property 'library'");

	this._observers = {
		pre: Object.create(null),
		post: Object.create(null)
	};

	this._handlers = Object.create(null);

	this._root = options._root || this;
	this._yield = options._yield;
	this._bind = options._bind;

	if (!document.getElementById("svelte-3994211942-style")) add_css();

	this._fragment = create_main_fragment(this._state, this);

	if (options.target) {
		if (options.hydrate) throw new Error("options.hydrate only works if the component was compiled with the `hydratable: true` option");
		this._fragment.create();
		this._fragment.mount(options.target, options.anchor || null);
	}
}

assign(AlbumsView.prototype, protoDev );

AlbumsView.prototype._checkReadOnly = function _checkReadOnly(newState) {
};

const EMPTY_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP';

class Player {
    constructor(library) {
        this.playing = null;
        this.paused = null;
        this.library = library;
        this.playlist = [];
        this.onplay = () => {};

        this._initElement();
    }

    play(songs) {
        this.playlist = songs.reverse();
        this.doPlay();
    }

    togglePause() {
        if(this.paused) {
            this.element.play();
            this.playing = this.paused;
            this.paused = null;
            this.onplay();
            return
        }

        this.element.pause();
        this.paused = this.playing;
        this.playing = null;
        this.onplay();
    }

    skip() {
        this.doPlay();
    }

    shuffle() {
        this.library.shuffle().then((ids) => ids.map((id) => {
            return this.library.getSong(id)
        })).then((songs) => {
            this.play(songs);
        });
    }

    doPlay() {
        this.paused = null;
        this.playing = null;
        if(this.playlist.length === 0) {
            this.onplay();

            // Don't pause an errored stream. This can cause a nasty
            // error loop, where pausing triggers reparsing bad input.
            if(!this.element.error) {
                this.element.pause();
            }
            return
        }

        const song = this.playlist.pop();
        this.playing = song;
        this.element.src = this.library.songUrl(song);
        this.element.play();

        this.onplay();
    }

    _initElement() {
        this.element = document.createElement('audio');
        this.element.controls = false;

        this.element.onended = () => {
            this.doPlay();
        };

        this.element.onerror = () => {
            const id = this.playing? this.playing.id : 'unknown';
            console.error(`Error playing ${id}`);
            this.doPlay();
        };
    }
}

class CoverSwitcher {
    constructor(elements) {
        this.elements = elements.slice(0, 2);
        this.curCover = null;
        this.cur = 0;
    }

    switch(url) {
        if(url === this.curCover) { return }

        this.curCover = url;

        this.currentElement.classList.add('old');
        this.cur = (this.cur + 1) % 2;
        this.currentElement.classList.remove('old');

        if(url === null) {
            this.currentElement.src = EMPTY_IMAGE;
            return
        }

        this.currentElement.src = url;
    }

    get currentElement() {
        return this.elements[this.cur]
    }
}

function main() {
    const playButton = document.getElementById('play-button');
    const skipButton = document.getElementById('skip-button');
    const labelElement = document.getElementById('caption');

    const coverSwitcher = new CoverSwitcher(Array.from(document.getElementsByClassName('cover')));
    const library = new MediaLibrary('http://localhost:8000/api');
    const player = new Player(library);

    library.refresh();

    player.onplay = () => {
        const song = player.playing || player.paused;

        if(song) {
            labelElement.textContent = `${song.artist} - ${song.title}`;

            library.getAlbumBySong(song.id).then((album) => {
                coverSwitcher.switch(library.getCover(album));
            });
        } else {
            coverSwitcher.switch(null);
            labelElement.textContent = '';
        }

        if(player.playing) {
            playButton.className = 'fa fa-pause playing';
        } else {
            playButton.className = 'fa fa-play';
        }
    };

    playButton.addEventListener('click', function() {
        if(player.playing) {
            player.togglePause();
        } else if(player.paused) {
            player.togglePause();
        } else {
            player.shuffle();
        }
    });

    skipButton.addEventListener('click', function() {
        player.skip();
    });

    const albumsButton = document.getElementById('albums-button');
    const albumsView = new AlbumsView({
        target: document.getElementById('album-list'),
        data: { library }
    });

    albumsView.on('shuffle', () => {
        player.shuffle();
        albumsView.set({ show: false });
    });

    albumsView.on('select', (album) => {
        const songs = album.tracks.map((id) => {
            return library.getSong(id)
        });

        player.play(songs);
        albumsView.set({ show: false });
    });

    albumsButton.addEventListener('click', function() {
        albumsView.set({ show: !albumsView.get('show') });
    });
}

window.addEventListener('DOMContentLoaded', function() {
    main();
});

}());
//# sourceMappingURL=app.js.map
