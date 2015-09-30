export type SongID = string
export type AlbumID = string

// Fisher-Yates Shuffle
function shuffle<T>(array: T[]): T[] {
    let counter = array.length
    let temp: T
    let index: number

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
    id: AlbumID
    title: string
    albumArtist: string
    year: string
    tracks: SongID[]
    private coverPath: string
    private cover: Blob

    constructor(id: AlbumID, title: string, albumArtist: string, year: string, tracks: SongID[], cover: string) {
        this.id = id
        this.title = title
        this.albumArtist = albumArtist
        this.year = year
        this.tracks = tracks

        this.coverPath = cover
        this.cover = null
    }

    getCover(library: MediaLibrary) {
        if(this.cover) {
            return new Promise((resolve, reject) => { resolve(this.cover); })
        }

        return self.fetch(`${library.root}/music/album/${this.id}/cover`).then((response) => {
            if(!response.ok) { return null }
            return response.blob()
        }).then((data: Blob) => {
            this.cover = data
            return data
        })
    }

    compare(other: Album): number {
        const thisCompiler = this.albumArtist.toLowerCase().split(/^"|the\W/i).join('')
        const otherCompiler = other.albumArtist.toLowerCase().split(/^"|the\W/i).join('')

        if(thisCompiler > otherCompiler) { return 1 }
        if(thisCompiler < otherCompiler) { return -1 }

        // Tie-break using year
        if(this.year > other.year) { return 1 }
        if(this.year < other.year) { return -1 }

        return 0
    }

    static parse(data: {id: string, title: string, album_artist: string, year: string, tracks: SongID[], cover: string}) {
        return new Album(data.id, data.title, data.album_artist, data.year, data.tracks, data.cover)
    }
}

export class Song {
    constructor(public id: SongID, public title: string, public artist: string) {}

    stream() {
        return `/music/song/${this.id}/stream`
    }

    static parse(data: {id: string, title: string, artist: string}) {
        return new Song(data.id, data.title, data.artist)
    }
}

export class MediaLibrary {
    root: string
    private songs: SongID[]
    private albums: AlbumID[]

    songCache: Map<SongID, Song>
    albumCache: Map<AlbumID, Album>

    artistIndex: Map<string, SongID[]>
    albumIndex: Map<SongID, AlbumID>

    constructor(root: string) {
        this.root = root

        this.songs = []
        this.albums = []

        this.songCache = new Map<SongID, Song>()
        this.albumCache = new Map<AlbumID, Album>()

        // this.artistIndex = new Map<string, SongID[]>()
        this.albumIndex = new Map<SongID, AlbumID>()
    }

    refresh() {
        const songs: SongID[] = []
        const albums = new Set<SongID>()
        const songCache = new Map<SongID, Song>()

        return self.fetch(`${this.root}/music/songs`).then((response) => {
            return response.json()
        }).then((results: any[]) => {
            for(let rawSong of results) {
                songs.push(rawSong.id)
                albums.add(rawSong.album)
                this.albumIndex.set(rawSong.id, rawSong.album)

                try {
                    songCache.set(rawSong.id, Song.parse(rawSong))
                } catch(err) {
                    console.error(`Error parsing song ${rawSong.id}`)
                    console.error(err)
                }
            }

            this.songs = songs
            this.albums = Array.from(albums.keys())
            this.songCache = songCache
        }).catch((err) => {
            console.error(err)
        })
    }

    shuffle() {
        return this.refresh().then(() => {
            shuffle(this.songs)
            return this.songs
        })
    }

    songUrl(song: Song): string {
        return this.root + song.stream()
    }

    getSong(id: SongID) {
        if(this.songCache.has(id)) {
            return this.songCache.get(id)
        } else {
            return null
        }
    }

    getAlbums() {
        const albums: Album[] = []
        return Promise.all(this.albums.map((id) => {
            return this.getAlbum(id).then((album: Album) => {
                albums.push(album)
            }).catch((err) => {
                console.error(err)
            })
        })).then(() => {
            return albums
        })
    }

    getAlbum(id: AlbumID) {
        if(this.albumCache.has(id)) {
            return new Promise((resolve, reject) => { resolve(this.albumCache.get(id)) })
        }

        return self.fetch(`${this.root}/music/album/${id}/metadata`).then((response) => {
            return response.json()
        }).then((data) => {
            const album = Album.parse(data)
            this.albumCache.set(id, album)
            return album
        })
    }

    getAlbumBySong(id: SongID) {
        return this.getAlbum(this.albumIndex.get(id))
    }
}
