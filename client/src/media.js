function ntoh(bytes, offset=0) {
    return (bytes[3 + offset] << 0) |
           (bytes[2 + offset] << 8) |
           (bytes[1 + offset] << 16) |
           (bytes[0 + offset] << 24)
}

// Fisher-Yates Shuffle
function shuffle(array) {
    let counter = array.length
    let temp
    let index

    // While there are elements in the array
    while (counter > 0) {
        // Pick a random index
        index = Math.floor(Math.random() * counter)
        counter -= 1

        // And swap the last element with it
        temp = array[counter]
        array[counter] = array[index]
        array[index] = temp
    }

    return array
}

export class Album {
    constructor(id, title, albumArtist, year, tracks) {
        this.id = id
        this.title = title
        this.albumArtist = albumArtist
        this.year = year
        this.tracks = tracks
        this.thumbnail = null

        this.haveCover = true
    }

    compare(other) {
        const thisCompiler = this.albumArtist.toLowerCase().split(/^"|the\W/i).join('')
        const otherCompiler = other.albumArtist.toLowerCase().split(/^"|the\W/i).join('')

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

export class Song {
    constructor(id, title, artist) {
        this.id = id
        this.title = title
        this.artist = artist
    }

    stream() {
        return `/music/song/${this.id}/stream`
    }

    static parse(data) {
        return new Song(data.id, data.title, data.artist)
    }
}

export class MediaLibrary {
    constructor(root) {
        this.root = root

        this.songs = []
        this.albums = []
        this.thumbnails = new Map()

        this.songCache = new Map()
        this.albumCache = new Map()

        // this.artistIndex = new Map()
        this.albumIndex = new Map()
    }

    async refresh() {
        const songs = []
        const songCache = new Map()
        const newAlbumIndex = new Map()

        try {
            const response = await self.fetch(`${this.root}/music/songs`)
            const data = await response.json()
            for(const rawSong of data.songs) {
                songs.push(rawSong.id)
                newAlbumIndex.set(rawSong.id, rawSong.album_id)

                try {
                    songCache.set(rawSong.id, Song.parse(rawSong))
                } catch(err) {
                    console.error(`Error parsing song ${rawSong.id}`)
                    console.error(err)
                }
            }
        } catch (err) {
            console.error('Error getting song manifest', err)
            return
        }

        this.songs = songs
        this.songCache = songCache
        this.albumIndex = newAlbumIndex
        this.albums = await this.getAlbums()

        await this.getThumbnails()
    }

    async shuffle() {
        await this.refresh()
        shuffle(this.songs)
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
        const albumList = Array.from(this.albums)
        const query = albumList.map((album) => encodeURIComponent(album.id)).join(',')
        const response = await fetch(`${this.root}/music/thumbnail?ids=${query}`)
        const body = await response.arrayBuffer()
        const view = new Uint8Array(body)

        let offset = 0
        const thumbnails = []
        while (offset < view.length) {
            const messageLength = ntoh(view, offset)
            offset += 4

            if (messageLength === 0) {
                thumbnails.push(null)
                continue
            }

            const blob = new Blob([view.slice(offset, messageLength + offset)], { type: 'image/jpeg' })
            offset += messageLength
            const url = URL.createObjectURL(blob)
            thumbnails.push(url)
        }

        for (const albumID of this.thumbnails.keys()) {
            URL.revokeObjectURL(this.thumbnails.get(albumID))
        }

        this.thumbnails.clear()
        for (let i = 0; i < thumbnails.length; i += 1) {
            if (thumbnails[i] !== null) {
                this.thumbnails.set(albumList[i].id, thumbnails[i])
            }
        }
    }

    async getAlbums() {
        const response = await self.fetch(`${this.root}/music/albums`)
        const data = await response.json()
        const albums = []
        for (const rawAlbum of data.albums) {
            const album = Album.parse(rawAlbum)
            this.albumCache.set(album.id, album)
            albums.push(album)
        }

        return albums
    }

    async getAlbum(id) {
        if(this.albumCache.has(id)) {
            return this.albumCache.get(id)
        }

        const response = await self.fetch(`${this.root}/music/album/${id}/metadata`)
        const data = await response.json()
        const album = Album.parse(data)
        this.albumCache.set(id, album)
        return album
    }

    getAlbumBySong(id) {
        return this.getAlbum(this.albumIndex.get(id))
    }
}
